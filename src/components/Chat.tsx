import { useState, useRef, useEffect, type FormEvent, type ChangeEvent, type ClipboardEvent } from 'react';
import { client, MODEL_ID, ASPECT_RATIOS, RESOLUTIONS, createImagePart, Modality, type AspectRatio, type Resolution, type ThoughtPart, type OutputPart, type Content, type UploadedImage, type Part } from '../lib/ai';

interface GenerationState {
  thoughts: ThoughtPart[];
  outputs: OutputPart[];
  isGenerating: boolean;
  phase: 'idle' | 'thinking' | 'generating' | 'done';
  error?: string;
  startTime?: number;
  endTime?: number;
}

interface ConversationTurn {
  role: 'user' | 'model';
  prompt?: string;
  images?: UploadedImage[];
  thoughts: ThoughtPart[];
  outputs: OutputPart[];
  aspectRatio: AspectRatio;
  resolution: Resolution;
  timestamp: Date;
}

interface SavedSessionMeta {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  thumbnail?: string;
  turnCount: number;
}

const STORAGE_KEY = 'gemini-sessions-meta';
const SESSION_PREFIX = 'gemini-session-';
const IMAGE_PREFIX = 'gemini-img-';
const THUMBNAIL_SIZE = 80;
const MAX_STORED_IMAGES = 50;

async function resizeImageToThumbnail(dataUrl: string): Promise<string> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d')!;
      
      const ratio = Math.min(THUMBNAIL_SIZE / img.width, THUMBNAIL_SIZE / img.height);
      canvas.width = Math.round(img.width * ratio);
      canvas.height = Math.round(img.height * ratio);
      
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      
      if (canvas.toDataURL('image/webp').startsWith('data:image/webp')) {
        resolve(canvas.toDataURL('image/webp', 0.8));
      } else {
        resolve(canvas.toDataURL('image/jpeg', 0.7));
      }
    };
    img.onerror = () => resolve('');
    img.src = dataUrl;
  });
}

function generateImageId(): string {
  return `img-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function storeImage(imageData: string): string | null {
  const id = generateImageId();
  try {
    localStorage.setItem(IMAGE_PREFIX + id, imageData);
    pruneOldImages();
    return id;
  } catch {
    return null;
  }
}

function loadImage(id: string): string | null {
  try {
    return localStorage.getItem(IMAGE_PREFIX + id);
  } catch {
    return null;
  }
}

function pruneOldImages() {
  try {
    const imageKeys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(IMAGE_PREFIX)) {
        imageKeys.push(key);
      }
    }
    
    if (imageKeys.length > MAX_STORED_IMAGES) {
      imageKeys.sort();
      const toRemove = imageKeys.slice(0, imageKeys.length - MAX_STORED_IMAGES);
      toRemove.forEach(key => localStorage.removeItem(key));
    }
  } catch {}
}

function loadSessionsMeta(): SavedSessionMeta[] {
  try {
    const data = localStorage.getItem(STORAGE_KEY);
    return data ? JSON.parse(data) : [];
  } catch {
    return [];
  }
}

function saveSessionsMeta(sessions: SavedSessionMeta[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(sessions));
  } catch (e) {
    console.warn('Failed to save sessions meta:', e);
  }
}

function loadSession(id: string): ConversationTurn[] | null {
  try {
    const data = localStorage.getItem(SESSION_PREFIX + id);
    if (!data) return null;
    const turns: ConversationTurn[] = JSON.parse(data);
    
    // Restore images from separate storage
    return turns.map(turn => ({
      ...turn,
      images: turn.images?.map(img => {
        if (img.storageId) {
          const restored = loadImage(img.storageId);
          return { ...img, dataUrl: restored || '' };
        }
        return img;
      }),
      outputs: turn.outputs.map(o => {
        if (o.type === 'image' && o.storageId) {
          const restored = loadImage(o.storageId);
          return { ...o, imageData: restored || '' };
        }
        return o;
      }),
      thoughts: turn.thoughts.map(t => {
        if (t.type === 'thought-image' && t.storageId) {
          const restored = loadImage(t.storageId);
          return { ...t, imageData: restored || '' };
        }
        return t;
      }),
    }));
  } catch {
    return null;
  }
}

function saveSession(id: string, conversation: ConversationTurn[]) {
  try {
    const forStorage = conversation.map(turn => ({
      ...turn,
      // Store user-uploaded images and save IDs
      images: turn.images?.map(img => {
        if (img.dataUrl && !img.storageId) {
          const storageId = storeImage(img.dataUrl);
          return { ...img, dataUrl: '', storageId };
        }
        return { ...img, dataUrl: '' };
      }),
      // Store generated images and save IDs
      outputs: turn.outputs.map(o => {
        if (o.type === 'image' && o.imageData && !o.storageId) {
          const storageId = storeImage(o.imageData);
          return { ...o, imageData: '', storageId };
        }
        return o.type === 'image' ? { ...o, imageData: '' } : o;
      }),
      // Store thought images and save IDs
      thoughts: turn.thoughts.map(t => {
        if (t.type === 'thought-image' && t.imageData && !t.storageId) {
          const storageId = storeImage(t.imageData);
          return { ...t, imageData: '', storageId };
        }
        return t.type === 'thought-image' ? { ...t, imageData: '' } : t;
      }),
    }));
    localStorage.setItem(SESSION_PREFIX + id, JSON.stringify(forStorage));
  } catch (e) {
    console.warn('Failed to save session:', e);
  }
}

function deleteSessionData(id: string) {
  try {
    localStorage.removeItem(SESSION_PREFIX + id);
  } catch {}
}

export function Chat() {
  const [input, setInput] = useState('');
  const [uploadedImages, setUploadedImages] = useState<UploadedImage[]>([]);
  const [aspectRatio, setAspectRatio] = useState<AspectRatio>('1:1');
  const [resolution, setResolution] = useState<Resolution>('1K');
  const [useGrounding, setUseGrounding] = useState(false);
  const [conversation, setConversation] = useState<ConversationTurn[]>([]);
  const [conversationHistory, setConversationHistory] = useState<Content[]>([]);
  const [current, setCurrent] = useState<GenerationState>({
    thoughts: [],
    outputs: [],
    isGenerating: false,
    phase: 'idle',
  });
  
  const [activeTab, setActiveTab] = useState<'config' | 'history'>('config');
  const [sessions, setSessions] = useState<SavedSessionMeta[]>([]);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [lastPrompt, setLastPrompt] = useState<string>('');
  const [lastImages, setLastImages] = useState<UploadedImage[]>([]);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const outputRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setSessions(loadSessionsMeta());
  }, []);

  useEffect(() => {
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [conversation, current.thoughts, current.outputs]);

  useEffect(() => {
    if (currentSessionId && conversation.length > 0) {
      (async () => {
        const firstImage = conversation
          .filter(t => t.role === 'model')
          .flatMap(t => t.outputs)
          .find(o => o.type === 'image' && o.imageData)?.imageData;
        
        const thumbnail = firstImage ? await resizeImageToThumbnail(firstImage) : undefined;
        const firstPrompt = conversation.find(t => t.role === 'user')?.prompt || 'Untitled';
        
        setSessions(prev => {
          const existing = prev.find(s => s.id === currentSessionId);
          const updated: SavedSessionMeta = {
            id: currentSessionId,
            name: firstPrompt.slice(0, 50),
            createdAt: existing?.createdAt || new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            thumbnail,
            turnCount: Math.ceil(conversation.length / 2),
          };
          
          const newSessions = existing 
            ? prev.map(s => s.id === currentSessionId ? updated : s)
            : [updated, ...prev];
          
          saveSessionsMeta(newSessions);
          return newSessions;
        });

        saveSession(currentSessionId, conversation);
      })();
    }
  }, [conversation, currentSessionId]);

  async function addImageFromFile(file: File): Promise<UploadedImage | null> {
    if (!file.type.startsWith('image/')) return null;

    const reader = new FileReader();
    const dataUrl = await new Promise<string>((resolve) => {
      reader.onload = () => resolve(reader.result as string);
      reader.readAsDataURL(file);
    });

    return {
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      dataUrl,
      mimeType: file.type,
      name: file.name || 'pasted-image',
    };
  }

  async function handleFileSelect(e: ChangeEvent<HTMLInputElement>) {
    const files = e.target.files;
    if (!files) return;

    const newImages: UploadedImage[] = [];
    
    for (const file of Array.from(files)) {
      if (uploadedImages.length + newImages.length >= 14) break;
      const img = await addImageFromFile(file);
      if (img) newImages.push(img);
    }

    setUploadedImages(prev => [...prev, ...newImages].slice(0, 14));
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  async function handlePaste(e: ClipboardEvent) {
    const items = e.clipboardData?.items;
    if (!items) return;

    const newImages: UploadedImage[] = [];

    for (const item of Array.from(items)) {
      if (item.type.startsWith('image/')) {
        e.preventDefault();
        const file = item.getAsFile();
        if (file && uploadedImages.length + newImages.length < 14) {
          const img = await addImageFromFile(file);
          if (img) newImages.push(img);
        }
      }
    }

    if (newImages.length > 0) {
      setUploadedImages(prev => [...prev, ...newImages].slice(0, 14));
    }
  }

  function removeImage(id: string) {
    setUploadedImages(prev => prev.filter(img => img.id !== id));
  }

  async function generateWithParams(prompt: string, images: UploadedImage[], useCurrentHistory: boolean = true) {
    if (current.isGenerating) return;

    const startTime = Date.now();

    if (!currentSessionId) {
      setCurrentSessionId(`session-${Date.now()}`);
    }

    setConversation(prev => [...prev, {
      role: 'user',
      prompt: prompt || undefined,
      images: images.length > 0 ? images : undefined,
      thoughts: [],
      outputs: [],
      aspectRatio,
      resolution,
      timestamp: new Date(),
    }]);

    setCurrent({
      thoughts: [],
      outputs: [],
      isGenerating: true,
      phase: 'generating',
      startTime,
    });

    setLastPrompt(prompt);
    setLastImages(images);

    try {
      const userParts: Part[] = [];
      
      if (prompt) {
        userParts.push({ text: prompt });
      }

      for (const img of images) {
        const base64 = img.dataUrl.split(',')[1];
        userParts.push(createImagePart(base64, img.mimeType));
      }

      const contents: Content[] = useCurrentHistory 
        ? [...conversationHistory, { role: 'user', parts: userParts }]
        : [{ role: 'user', parts: userParts }];

      const response = await client.models.generateContent({
        model: MODEL_ID,
        contents,
        config: {
          responseModalities: [Modality.TEXT, Modality.IMAGE],
          imageConfig: {
            aspectRatio,
            imageSize: resolution,
          },
          ...(useGrounding ? { tools: [{ googleSearch: {} }] } : {}),
        },
      });

      const endTime = Date.now();
      const parts = response.candidates?.[0]?.content?.parts || [];
      
      const collectedThoughts: ThoughtPart[] = [];
      const collectedOutputs: OutputPart[] = [];

      for (const part of parts) {
        const rawPart = part as Record<string, unknown>;
        const isThought = rawPart.thought === true;

        if (part.text) {
          if (isThought) {
            collectedThoughts.push({ type: 'thought-text', text: part.text });
          } else {
            collectedOutputs.push({ 
              type: 'text', 
              text: part.text, 
              signature: rawPart.thoughtSignature as string 
            });
          }
        } else if (part.inlineData) {
          const mimeType = part.inlineData.mimeType || 'image/png';
          const data = part.inlineData.data;

          if (isThought) {
            collectedThoughts.push({ 
              type: 'thought-image', 
              imageData: `data:${mimeType};base64,${data}`, 
              mimeType 
            });
          } else {
            collectedOutputs.push({ 
              type: 'image', 
              imageData: `data:${mimeType};base64,${data}`, 
              mimeType, 
              signature: rawPart.thoughtSignature as string 
            });
          }
        }
      }

      setCurrent({
        thoughts: collectedThoughts,
        outputs: collectedOutputs,
        isGenerating: false,
        phase: 'done',
        startTime,
        endTime,
      });

      setConversation(prev => [...prev, {
        role: 'model',
        thoughts: collectedThoughts,
        outputs: collectedOutputs,
        aspectRatio,
        resolution,
        timestamp: new Date(),
      }]);

      const modelParts = parts.map(p => {
        const raw = p as Record<string, unknown>;
        if (raw.thought === true) return null;
        if (raw.thoughtSignature) {
          return { ...p, thoughtSignature: raw.thoughtSignature };
        }
        return p;
      }).filter(Boolean) as Part[];

      setConversationHistory(prev => [
        ...prev, 
        { role: 'user', parts: userParts }, 
        { role: 'model', parts: modelParts }
      ]);

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      setCurrent(prev => ({ ...prev, isGenerating: false, phase: 'done', error: errorMessage }));
    }
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if ((!input.trim() && uploadedImages.length === 0) || current.isGenerating) return;

    const prompt = input.trim();
    const images = [...uploadedImages];
    setInput('');
    setUploadedImages([]);
    
    await generateWithParams(prompt, images, true);
  }

  async function handleRegenerate() {
    if (!lastPrompt && lastImages.length === 0) return;
    
    if (conversation.length >= 2 && conversation[conversation.length - 1].role === 'model') {
      setConversation(prev => prev.slice(0, -2));
      setConversationHistory(prev => prev.slice(0, -2));
    }
    
    await generateWithParams(lastPrompt, lastImages, true);
  }

  function handleNewSession() {
    setConversation([]);
    setConversationHistory([]);
    setUploadedImages([]);
    setCurrentSessionId(null);
    setLastPrompt('');
    setLastImages([]);
    setCurrent({
      thoughts: [],
      outputs: [],
      isGenerating: false,
      phase: 'idle',
    });
  }

  function handleLoadSession(session: SavedSessionMeta) {
    const data = loadSession(session.id);
    if (data) {
      setConversation(data.map(t => ({ ...t, timestamp: new Date(t.timestamp) })));
      setCurrentSessionId(session.id);
      setConversationHistory([]);
      setCurrent({ thoughts: [], outputs: [], isGenerating: false, phase: 'idle' });
      setActiveTab('config');
    }
  }

  function handleDeleteSession(id: string) {
    deleteSessionData(id);
    setSessions(prev => {
      const newSessions = prev.filter(s => s.id !== id);
      saveSessionsMeta(newSessions);
      return newSessions;
    });
    if (currentSessionId === id) {
      handleNewSession();
    }
  }

  const duration = current.startTime && current.endTime
    ? ((current.endTime - current.startTime) / 1000).toFixed(1)
    : null;

  const lastModelTurn = [...conversation].reverse().find(t => t.role === 'model');
  const canSubmit = (input.trim() || uploadedImages.length > 0) && !current.isGenerating;
  const canRegenerate = (lastPrompt || lastImages.length > 0) && !current.isGenerating;

  return (
    <div className="studio">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-icon">◇</div>
          <div className="brand-text">
            <span className="brand-name">GEMINI</span>
            <span className="brand-sub">3 PRO IMAGE</span>
          </div>
        </div>

        <div className="tab-switcher">
          <button 
            className={`tab-btn ${activeTab === 'config' ? 'active' : ''}`}
            onClick={() => setActiveTab('config')}
          >
            CONFIG
          </button>
          <button 
            className={`tab-btn ${activeTab === 'history' ? 'active' : ''}`}
            onClick={() => setActiveTab('history')}
          >
            HISTORY ({sessions.length})
          </button>
        </div>

        {activeTab === 'config' && (
          <>
            <div className="config-section">
              <label className="config-label">MODEL</label>
              <div className="config-value config-mono">{MODEL_ID}</div>
            </div>

            <div className="config-section">
              <label className="config-label">RESOLUTION</label>
              <div className="resolution-btns">
                {RESOLUTIONS.map(res => (
                  <button
                    key={res.value}
                    type="button"
                    onClick={() => setResolution(res.value)}
                    className={`res-btn ${resolution === res.value ? 'active' : ''}`}
                    disabled={current.isGenerating}
                  >
                    <span className="res-label">{res.label}</span>
                    <span className="res-desc">{res.desc}</span>
                  </button>
                ))}
              </div>
            </div>

            <div className="config-section">
              <label className="config-label">ASPECT RATIO</label>
              <div className="ratio-grid">
                {ASPECT_RATIOS.slice(0, 6).map(ratio => (
                  <button
                    key={ratio.value}
                    type="button"
                    onClick={() => setAspectRatio(ratio.value)}
                    className={`ratio-btn ${aspectRatio === ratio.value ? 'active' : ''}`}
                    disabled={current.isGenerating}
                    title={ratio.label}
                  >
                    <span className="ratio-icon">{ratio.icon}</span>
                    <span className="ratio-label">{ratio.label}</span>
                  </button>
                ))}
              </div>
            </div>

            <div className="config-section">
              <label className="config-label">GROUNDING</label>
              <button
                type="button"
                onClick={() => setUseGrounding(!useGrounding)}
                className={`toggle-btn ${useGrounding ? 'active' : ''}`}
                disabled={current.isGenerating}
              >
                <span className="toggle-icon">{useGrounding ? '◉' : '○'}</span>
                <span className="toggle-text">Google Search</span>
              </button>
            </div>

            <div className="config-section">
              <label className="config-label">SESSION</label>
              <div className="session-actions">
                <button 
                  type="button" 
                  onClick={handleNewSession} 
                  className="action-btn"
                  disabled={current.isGenerating}
                >
                  + New
                </button>
                {canRegenerate && (
                  <button 
                    type="button" 
                    onClick={handleRegenerate} 
                    className="action-btn regenerate"
                    disabled={current.isGenerating}
                    title="Regenerate with current settings"
                  >
                    ↻ Regen
                  </button>
                )}
              </div>
            </div>
          </>
        )}

        {activeTab === 'history' && (
          <div className="history-tab">
            {sessions.length === 0 ? (
              <div className="empty-history">
                <p>No saved sessions yet</p>
              </div>
            ) : (
              <div className="sessions-list">
                {sessions.map(session => (
                  <div 
                    key={session.id} 
                    className={`session-card ${currentSessionId === session.id ? 'active' : ''}`}
                    onClick={() => handleLoadSession(session)}
                  >
                    {session.thumbnail && (
                      <div className="session-thumb">
                        <img src={session.thumbnail} alt="" />
                      </div>
                    )}
                    <div className="session-info">
                      <div className="session-name">{session.name}</div>
                      <div className="session-date">
                        {session.turnCount} turn{session.turnCount > 1 ? 's' : ''} · {new Date(session.updatedAt).toLocaleDateString()}
                      </div>
                    </div>
                    <button 
                      className="delete-session-btn"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDeleteSession(session.id);
                      }}
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </aside>

      <main className="workspace">
        <div className="conversation-area" ref={outputRef}>
          {conversation.length === 0 && current.phase === 'idle' && (
            <div className="empty-state">
              <div className="empty-icon">◈</div>
              <h2>Gemini 3 Pro Image</h2>
              <p>Generate and edit images with multi-turn conversation. Paste images from clipboard (Ctrl+V) or upload reference images.</p>
              <div className="feature-tags">
                <span className="feature-tag">Paste from Clipboard</span>
                <span className="feature-tag">Session History</span>
                <span className="feature-tag">4K Output</span>
              </div>
            </div>
          )}

          {conversation.map((turn, idx) => (
            <div key={idx} className={`turn turn-${turn.role}`}>
              {turn.role === 'user' && (
                <div className="user-message">
                  <div className="message-meta">
                    <span className="role-label">YOU</span>
                    <span className="turn-config">{turn.resolution} · {turn.aspectRatio}</span>
                  </div>
                  {turn.prompt && <div className="message-content">{turn.prompt}</div>}
                  {turn.images && turn.images.length > 0 && (
                    <div className="user-images">
                      {turn.images.map((img, imgIdx) => (
                        <div key={imgIdx} className="user-image-thumb">
                          {img.dataUrl && <img src={img.dataUrl} alt={img.name} />}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {turn.role === 'model' && (
                <div className="model-message">
                  {turn.thoughts.length > 0 && (
                    <details className="thinking-details" open={idx === conversation.length - 1}>
                      <summary className="thinking-summary">
                        <span className="thinking-icon">◐</span>
                        THINKING ({turn.thoughts.length} part{turn.thoughts.length > 1 ? 's' : ''})
                      </summary>
                      <div className="thinking-content-wrap">
                        {turn.thoughts.map((thought, tIdx) => (
                          <div key={tIdx} className="thought-item">
                            {thought.type === 'thought-text' && <pre className="thinking-content">{thought.text}</pre>}
                            {thought.type === 'thought-image' && thought.imageData && (
                              <div className="thought-image-card">
                                <img src={thought.imageData} alt={`Draft ${tIdx + 1}`} />
                                <span className="thought-badge">Draft {tIdx + 1}</span>
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    </details>
                  )}

                  {turn.outputs.map((output, oIdx) => (
                    <div key={oIdx} className="output-item">
                      {output.type === 'text' && output.text && <div className="response-text">{output.text}</div>}
                      {output.type === 'image' && output.imageData && (
                        <figure className="output-image">
                          <img src={output.imageData} alt={`Generated ${oIdx + 1}`} />
                          <figcaption>
                            <span className="image-meta">{turn.resolution} · {turn.aspectRatio}</span>
                            <a href={output.imageData} download={`gemini-${turn.resolution}-${turn.aspectRatio.replace(':', 'x')}-${Date.now()}.png`}>
                              ↓ Download
                            </a>
                          </figcaption>
                        </figure>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}

          {current.isGenerating && (
            <div className="generating-indicator">
              <div className="streaming-badge large">
                <span className="pulse"></span>
                GENERATING...
              </div>
            </div>
          )}

          {current.error && (
            <div className="error-banner">
              <span className="error-icon">!</span>
              {current.error}
            </div>
          )}
        </div>

        <form onSubmit={handleSubmit} className="prompt-form sticky">
          {lastModelTurn && lastModelTurn.outputs.some(o => o.type === 'image') && (
            <div className="edit-hint">
              Continue editing or paste/upload new reference images
            </div>
          )}

          {uploadedImages.length > 0 && (
            <div className="uploaded-images-row">
              {uploadedImages.map(img => (
                <div key={img.id} className="uploaded-image-preview">
                  <img src={img.dataUrl} alt={img.name} />
                  <button
                    type="button"
                    className="remove-image-btn"
                    onClick={() => removeImage(img.id)}
                    disabled={current.isGenerating}
                  >
                    ×
                  </button>
                </div>
              ))}
              <span className="image-count">{uploadedImages.length}/14</span>
            </div>
          )}

          <div className="input-wrapper">
            <div className="input-row">
              <button
                type="button"
                className="upload-btn"
                onClick={() => fileInputRef.current?.click()}
                disabled={current.isGenerating || uploadedImages.length >= 14}
                title="Upload reference images (up to 14)"
              >
                <span className="upload-icon">+</span>
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                multiple
                onChange={handleFileSelect}
                style={{ display: 'none' }}
              />
              <textarea
                ref={textareaRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onPaste={handlePaste}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    handleSubmit(e);
                  }
                }}
                placeholder={uploadedImages.length > 0 
                  ? "Describe what to do with these images..." 
                  : conversation.length > 0 
                    ? "Describe your edit... (Ctrl+V to paste)" 
                    : "Describe your vision or paste images (Ctrl+V)..."}
                disabled={current.isGenerating}
                className="prompt-input"
                rows={2}
              />
              <button type="submit" disabled={!canSubmit} className="btn btn-generate">
                <span className="btn-icon">→</span>
                {current.isGenerating ? '...' : conversation.length > 0 ? 'EDIT' : 'GO'}
              </button>
            </div>
          </div>
          {duration && !current.isGenerating && (
            <div className="timing-info">Generated in {duration}s</div>
          )}
        </form>
      </main>
    </div>
  );
}
