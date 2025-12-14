import { useState, useRef, useEffect, type FormEvent, type ChangeEvent, type ClipboardEvent } from 'react';
import { client, MODEL_ID, ASPECT_RATIOS, RESOLUTIONS, createImagePart, Modality, type AspectRatio, type Resolution, type ThoughtPart, type OutputPart, type Content, type UploadedImage, type Part } from '../lib/ai';
import * as storage from '../lib/storage';

interface GenerationState {
  thoughts: ThoughtPart[];
  outputs: OutputPart[];
  isGenerating: boolean;
  phase: 'idle' | 'thinking' | 'generating' | 'done';
  error?: string;
  startTime?: number;
  endTime?: number;
}

// A single version of a user+model turn pair
interface TurnVersion {
  id: string;
  userPrompt?: string;
  userImages?: UploadedImage[];
  modelThoughts: ThoughtPart[];
  modelOutputs: OutputPart[];
  aspectRatio: AspectRatio;
  resolution: Resolution;
  timestamp: Date;
  generationTime?: number;
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
  generationTime?: number;
  // Branching support: store alternate versions of this turn pair
  versions?: TurnVersion[];
  selectedVersion?: number;
  // Unique ID for this turn (for branching reference)
  turnId?: string;
}

interface SavedSessionMeta {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  thumbnail?: string;
  turnCount: number;
}

interface ImageLightbox {
  imageData: string;
  prompt?: string;
  resolution: Resolution;
  aspectRatio: AspectRatio;
  generationTime?: number;
  timestamp: Date;
}

const THUMBNAIL_SIZE = 80;

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
      resolve(canvas.toDataURL('image/webp', 0.8));
    };
    img.onerror = () => resolve('');
    img.src = dataUrl;
  });
}

async function convertToWebP(dataUrl: string, quality = 0.6): Promise<string> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(img, 0, 0);
      resolve(canvas.toDataURL('image/webp', quality));
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}

function dataUrlToBlobUrl(dataUrl: string): string {
  try {
    const [header, base64] = dataUrl.split(',');
    const mimeMatch = header.match(/:(.*?);/);
    const mimeType = mimeMatch ? mimeMatch[1] : 'image/png';
    const binary = atob(base64);
    const array = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      array[i] = binary.charCodeAt(i);
    }
    const blob = new Blob([array], { type: mimeType });
    return URL.createObjectURL(blob);
  } catch {
    return dataUrl;
  }
}

function openImageInNewTab(imageUrl: string) {
  if (imageUrl.startsWith('data:')) {
    const blobUrl = dataUrlToBlobUrl(imageUrl);
    window.open(blobUrl, '_blank');
  } else {
    window.open(imageUrl, '_blank');
  }
}

async function downloadImage(imageUrl: string, filename: string) {
  try {
    const response = await fetch(imageUrl);
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  } catch (e) {
    console.error('Download failed:', e);
  }
}

async function storeImageToDB(imageData: string): Promise<string | null> {
  try {
    const webpData = await convertToWebP(imageData, 0.6);
    return await storage.saveImage(webpData);
  } catch (e) {
    console.error('Failed to store image:', e);
    return null;
  }
}

function getImageUrl(id: string): string {
  return `/api/images/${id}`;
}

async function loadSessionFromDB(id: string): Promise<ConversationTurn[] | null> {
  try {
    const data = await storage.getSession(id) as ConversationTurn[] | null;
    if (!data) return null;

    const turns = data.map(turn => ({
      ...turn,
      timestamp: new Date(turn.timestamp),
      images: turn.images?.map(img => {
        if (img.storageId) {
          return { ...img, dataUrl: getImageUrl(img.storageId) };
        }
        return img;
      }),
      outputs: turn.outputs.map(o => {
        if (o.type === 'image' && o.storageId) {
          return { ...o, imageData: getImageUrl(o.storageId) };
        }
        return o;
      }),
      thoughts: turn.thoughts.map(t => {
        if (t.type === 'thought-image' && t.storageId) {
          return { ...t, imageData: getImageUrl(t.storageId) };
        }
        return t;
      }),
    }));

    return turns;
  } catch {
    return null;
  }
}

async function saveSessionToDB(id: string, conversation: ConversationTurn[]): Promise<ConversationTurn[]> {
  try {
    const forStorage = await Promise.all(conversation.map(async turn => ({
      ...turn,
      images: turn.images ? await Promise.all(turn.images.map(async img => {
        if (img.dataUrl && !img.storageId) {
          const storageId = await storeImageToDB(img.dataUrl);
          return { ...img, storageId: storageId || img.storageId };
        }
        return img;
      })) : undefined,
      outputs: await Promise.all(turn.outputs.map(async o => {
        if (o.type === 'image' && o.imageData && !o.storageId) {
          const storageId = await storeImageToDB(o.imageData);
          return { ...o, storageId: storageId || o.storageId };
        }
        return o;
      })),
      thoughts: await Promise.all(turn.thoughts.map(async t => {
        if (t.type === 'thought-image' && t.imageData && !t.storageId) {
          const storageId = await storeImageToDB(t.imageData);
          return { ...t, storageId: storageId || t.storageId };
        }
        return t;
      })),
    })));

    const toSave = forStorage.map(turn => ({
      ...turn,
      images: turn.images?.map(img => ({ ...img, dataUrl: '' })),
      outputs: turn.outputs.map(o => o.type === 'image' ? { ...o, imageData: '' } : o),
      thoughts: turn.thoughts.map(t => t.type === 'thought-image' ? { ...t, imageData: '' } : t),
    }));

    await storage.saveSession(id, toSave);
    return forStorage;
  } catch (e) {
    console.warn('Failed to save session:', e);
    return conversation;
  }
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
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sessions, setSessions] = useState<SavedSessionMeta[]>([]);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [lastPrompt, setLastPrompt] = useState<string>('');
  const [lastImages, setLastImages] = useState<UploadedImage[]>([]);
  const [lightbox, setLightbox] = useState<ImageLightbox | null>(null);
  
  // Edit mode state for branching
  const [editingTurnIdx, setEditingTurnIdx] = useState<number | null>(null);
  const [editInput, setEditInput] = useState('');
  const [editImages, setEditImages] = useState<UploadedImage[]>([]);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const outputRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    storage.getAllSessionsMeta().then(setSessions);
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
        
        const existing = sessions.find(s => s.id === currentSessionId);
        const updated: SavedSessionMeta = {
          id: currentSessionId,
          name: firstPrompt.slice(0, 50),
          createdAt: existing?.createdAt || new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          thumbnail,
          turnCount: Math.ceil(conversation.length / 2),
        };
        
        await storage.saveSessionMeta(updated);
        
        const newSessions = existing 
          ? sessions.map(s => s.id === currentSessionId ? updated : s)
          : [updated, ...sessions];
        setSessions(newSessions);

        const updatedConversation = await saveSessionToDB(currentSessionId, conversation);
        
        const hasNewStorageIds = updatedConversation.some((turn, idx) => {
          const original = conversation[idx];
          if (!original) return false;
          const hasNewImageId = turn.images?.some((img, i) => img.storageId && !original.images?.[i]?.storageId);
          const hasNewOutputId = turn.outputs.some((o, i) => o.storageId && !original.outputs[i]?.storageId);
          const hasNewThoughtId = turn.thoughts.some((t, i) => t.storageId && !original.thoughts[i]?.storageId);
          return hasNewImageId || hasNewOutputId || hasNewThoughtId;
        });
        
        if (hasNewStorageIds) {
          setConversation(updatedConversation);
        }
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

  const [isDragging, setIsDragging] = useState(false);

  function handleDragOver(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
  }

  function handleDragEnter(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer?.types.includes('Files')) {
      setIsDragging(true);
    }
  }

  function handleDragLeave(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const x = e.clientX;
    const y = e.clientY;
    if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) {
      setIsDragging(false);
    }
  }

  async function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);

    const files = e.dataTransfer?.files;
    if (!files || files.length === 0) return;

    const newImages: UploadedImage[] = [];

    for (const file of Array.from(files)) {
      if (!file.type.startsWith('image/')) continue;
      if (uploadedImages.length + newImages.length >= 14) break;
      const img = await addImageFromFile(file);
      if (img) newImages.push(img);
    }

    if (newImages.length > 0) {
      setUploadedImages(prev => [...prev, ...newImages].slice(0, 14));
    }
  }

  function removeImage(id: string) {
    setUploadedImages(prev => prev.filter(img => img.id !== id));
  }

  async function generateWithParams(
    prompt: string, 
    images: UploadedImage[], 
    useCurrentHistory: boolean = true,
    overrideAspectRatio?: AspectRatio,
    overrideResolution?: Resolution
  ) {
    if (current.isGenerating) return;

    const startTime = Date.now();
    
    // Use overrides if provided, otherwise use current sidebar settings
    const effectiveAspectRatio = overrideAspectRatio ?? aspectRatio;
    const effectiveResolution = overrideResolution ?? resolution;

    if (!currentSessionId) {
      setCurrentSessionId(`${Date.now()}`);
    }

    setConversation(prev => [...prev, {
      role: 'user',
      prompt: prompt || undefined,
      images: images.length > 0 ? images : undefined,
      thoughts: [],
      outputs: [],
      aspectRatio: effectiveAspectRatio,
      resolution: effectiveResolution,
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
            aspectRatio: effectiveAspectRatio,
            imageSize: effectiveResolution,
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
        aspectRatio: effectiveAspectRatio,
        resolution: effectiveResolution,
        timestamp: new Date(),
        generationTime: endTime - startTime,
      }]);

      const modelParts: Part[] = [];
      
      for (const part of parts) {
        const raw = part as Record<string, unknown>;
        
        // Skip thought parts
        if (raw.thought === true) continue;
        
        if (part.text) {
          // Text part - include thoughtSignature if present
          const textPart: Record<string, unknown> = { text: part.text };
          if (raw.thoughtSignature) {
            textPart.thoughtSignature = raw.thoughtSignature;
          }
          modelParts.push(textPart as Part);
        } else if (part.inlineData) {
          // Image part - MUST include thoughtSignature for multi-turn
          const imagePart: Record<string, unknown> = {
            inlineData: {
              mimeType: part.inlineData.mimeType || 'image/png',
              data: part.inlineData.data,
            }
          };
          if (raw.thoughtSignature) {
            imagePart.thoughtSignature = raw.thoughtSignature;
          }
          modelParts.push(imagePart as Part);
        }
      }

      // Debug: log the history being sent
      console.log('[DEBUG] Conversation history being sent:', JSON.stringify(
        [...conversationHistory, { role: 'user', parts: userParts }, { role: 'model', parts: modelParts }]
          .map(c => ({
            role: c.role,
            parts: (c.parts || []).map((p) => {
              const part = p as Record<string, unknown>;
              return {
                hasText: !!part.text,
                hasImage: !!part.inlineData,
                hasSignature: !!part.thoughtSignature,
              };
            })
          })),
        null, 2
      ));

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

  async function handleRegenerate(turnIdx?: number) {
    if (current.isGenerating) return;
    
    // If turnIdx provided, regenerate that specific turn
    if (turnIdx !== undefined) {
      // Find the user turn that precedes this model turn
      const userTurnIdx = turnIdx - 1;
      if (userTurnIdx < 0 || conversation[userTurnIdx]?.role !== 'user') return;
      
      const userTurn = conversation[userTurnIdx];
      const prompt = userTurn.prompt || '';
      const images = userTurn.images || [];
      
      // Remove this turn and all turns after it
      setConversation(prev => prev.slice(0, userTurnIdx));
      setConversationHistory(prev => {
        // Calculate how many history entries to keep
        const turnsToKeep = userTurnIdx;
        const historyEntriesToKeep = Math.floor(turnsToKeep / 2) * 2;
        return prev.slice(0, historyEntriesToKeep);
      });
      
      await generateWithParams(prompt, images, true);
      return;
    }
    
    // Default behavior: regenerate last turn
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

  async function handleLoadSession(session: SavedSessionMeta) {
    const data = await loadSessionFromDB(session.id);
    if (data) {
      setConversation(data);
      setCurrentSessionId(session.id);
      
      // Rebuild conversation history from loaded turns
      const history: Content[] = [];
      for (const turn of data) {
        const parts: Part[] = [];
        
        if (turn.role === 'user') {
          if (turn.prompt) {
            parts.push({ text: turn.prompt });
          }
          if (turn.images) {
            for (const img of turn.images) {
              const base64 = img.dataUrl.split(',')[1];
              if (base64) {
                parts.push({
                  inlineData: {
                    mimeType: img.mimeType,
                    data: base64,
                  }
                });
              }
            }
          }
        } else if (turn.role === 'model') {
          for (const output of turn.outputs) {
            if (output.type === 'text') {
              // Include signature for text parts
              const textPart: Record<string, unknown> = { text: output.text };
              if (output.signature) {
                textPart.thoughtSignature = output.signature;
              }
              parts.push(textPart as Part);
            } else if (output.type === 'image' && output.imageData) {
              // Get base64 from the imageData (could be data URL or storage URL)
              let base64 = '';
              if (output.imageData.startsWith('data:')) {
                base64 = output.imageData.split(',')[1];
              } else if (output.storageId) {
                // For storage URLs, we need to fetch the image
                try {
                  const response = await fetch(output.imageData);
                  const blob = await response.blob();
                  const reader = new FileReader();
                  const dataUrl = await new Promise<string>((resolve) => {
                    reader.onloadend = () => resolve(reader.result as string);
                    reader.readAsDataURL(blob);
                  });
                  base64 = dataUrl.split(',')[1];
                } catch (e) {
                  console.error('Failed to load image for history:', e);
                }
              }
              if (base64) {
                // MUST include thoughtSignature for model-generated images
                const imagePart: Record<string, unknown> = {
                  inlineData: {
                    mimeType: output.mimeType || 'image/png',
                    data: base64,
                  }
                };
                if (output.signature) {
                  imagePart.thoughtSignature = output.signature;
                }
                parts.push(imagePart as Part);
              }
            }
          }
        }
        
        if (parts.length > 0) {
          history.push({ role: turn.role, parts });
        }
      }
      
      setConversationHistory(history);
      setCurrent({ thoughts: [], outputs: [], isGenerating: false, phase: 'idle' });
      setActiveTab('config');
    }
  }

  async function handleDeleteSession(id: string) {
    await storage.deleteSession(id);
    await storage.deleteSessionMeta(id);
    setSessions(prev => prev.filter(s => s.id !== id));
    if (currentSessionId === id) {
      handleNewSession();
    }
  }

  // ===== BRANCHING HANDLERS =====
  
  // Start editing a user message (for branching)
  function handleStartEdit(turnIdx: number) {
    const turn = conversation[turnIdx];
    if (turn?.role !== 'user') return;
    
    setEditingTurnIdx(turnIdx);
    setEditInput(turn.prompt || '');
    setEditImages(turn.images || []);
  }
  
  // Cancel editing
  function handleCancelEdit() {
    setEditingTurnIdx(null);
    setEditInput('');
    setEditImages([]);
  }
  
  // Save edit and regenerate (creates a new branch/version)
  async function handleSaveEdit() {
    if (editingTurnIdx === null || current.isGenerating) return;
    
    const userTurnIdx = editingTurnIdx;
    const modelTurnIdx = userTurnIdx + 1;
    const userTurn = conversation[userTurnIdx];
    const modelTurn = conversation[modelTurnIdx];
    
    if (!userTurn || userTurn.role !== 'user') return;
    
    // Preserve the original turn's parameters
    const originalAspectRatio = userTurn.aspectRatio;
    const originalResolution = userTurn.resolution;
    
    // Create a version of the current state before editing
    const currentVersion: TurnVersion = {
      id: `v-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      userPrompt: userTurn.prompt,
      userImages: userTurn.images,
      modelThoughts: modelTurn?.thoughts || [],
      modelOutputs: modelTurn?.outputs || [],
      aspectRatio: originalAspectRatio,
      resolution: originalResolution,
      timestamp: userTurn.timestamp,
      generationTime: modelTurn?.generationTime,
    };
    
    // Get existing versions or create new array
    const existingVersions = userTurn.versions || [];
    // Only add current state to versions if it's not already there (first edit)
    const versions = existingVersions.length === 0 
      ? [currentVersion] 
      : existingVersions;
    
    const newPrompt = editInput.trim();
    const newImages = [...editImages];
    
    // Truncate conversation BEFORE the edited turn (we'll add it fresh via generateWithParams)
    const truncatedConversation = conversation.slice(0, userTurnIdx);
    
    // Store versions info to be added after generation
    // We need to pass this through the generation cycle
    const versionsToPreserve = versions;
    
    setConversation(truncatedConversation);
    
    // Rebuild history from the truncated conversation (turns before the edited one)
    await rebuildConversationHistory(truncatedConversation);
    
    // Clear edit state
    setEditingTurnIdx(null);
    setEditInput('');
    setEditImages([]);
    
    // Regenerate with new prompt but using ORIGINAL parameters
    await generateWithParams(
      newPrompt, 
      newImages, 
      true,
      originalAspectRatio,
      originalResolution
    );
    
    // After generation completes, update the user turn to include versions
    setConversation(prev => {
      if (prev.length < 2) return prev;
      const lastUserIdx = prev.length - 2;
      const lastUser = prev[lastUserIdx];
      if (lastUser?.role !== 'user') return prev;
      
      return prev.map((turn, idx) => {
        if (idx === lastUserIdx) {
          return {
            ...turn,
            versions: versionsToPreserve,
            selectedVersion: versionsToPreserve.length,
          };
        }
        return turn;
      });
    });
  }
  
  // Delete a turn pair (user + model)
  function handleDeleteTurn(turnIdx: number) {
    if (current.isGenerating) return;
    
    const turn = conversation[turnIdx];
    if (!turn) return;
    
    // Find the pair to delete
    let startIdx: number, endIdx: number;
    
    if (turn.role === 'user') {
      startIdx = turnIdx;
      endIdx = turnIdx + 2; // Include the model response
    } else {
      // Model turn - delete it and the preceding user turn
      startIdx = turnIdx - 1;
      endIdx = turnIdx + 1;
    }
    
    // Ensure valid range
    startIdx = Math.max(0, startIdx);
    endIdx = Math.min(conversation.length, endIdx);
    
    const newConversation = [
      ...conversation.slice(0, startIdx),
      ...conversation.slice(endIdx),
    ];
    
    setConversation(newConversation);
    
    // Rebuild history from remaining turns
    rebuildConversationHistory(newConversation);
  }
  
  // Navigate between versions of a branched message
  function handleVersionChange(turnIdx: number, direction: 'prev' | 'next') {
    const userTurn = conversation[turnIdx];
    if (!userTurn || userTurn.role !== 'user' || !userTurn.versions) return;
    
    const currentVersion = userTurn.selectedVersion ?? userTurn.versions.length;
    const maxVersion = userTurn.versions.length;
    
    let newVersion: number;
    if (direction === 'prev') {
      newVersion = Math.max(0, currentVersion - 1);
    } else {
      newVersion = Math.min(maxVersion, currentVersion + 1);
    }
    
    if (newVersion === currentVersion) return;
    
    // Get the version data
    const versionData = userTurn.versions[newVersion];
    if (!versionData && newVersion !== maxVersion) return;
    
    // Update the conversation with the selected version's data
    const modelTurnIdx = turnIdx + 1;
    
    if (newVersion < maxVersion && versionData) {
      // Switch to a previous version
      const updatedUserTurn: ConversationTurn = {
        ...userTurn,
        prompt: versionData.userPrompt,
        images: versionData.userImages,
        selectedVersion: newVersion,
      };
      
      const updatedModelTurn: ConversationTurn = {
        role: 'model',
        thoughts: versionData.modelThoughts,
        outputs: versionData.modelOutputs,
        aspectRatio: versionData.aspectRatio,
        resolution: versionData.resolution,
        timestamp: versionData.timestamp,
        generationTime: versionData.generationTime,
      };
      
      const newConversation = [
        ...conversation.slice(0, turnIdx),
        updatedUserTurn,
        updatedModelTurn,
        ...conversation.slice(modelTurnIdx + 1),
      ];
      
      setConversation(newConversation);
      rebuildConversationHistory(newConversation);
    } else {
      // Switch back to current (latest) version - restore from the last item or current state
      const updatedUserTurn: ConversationTurn = {
        ...userTurn,
        selectedVersion: newVersion,
      };
      
      setConversation(prev => {
        const newConv = [...prev];
        newConv[turnIdx] = updatedUserTurn;
        return newConv;
      });
    }
  }
  
  // Helper to rebuild conversation history from turns
  async function rebuildConversationHistory(turns: ConversationTurn[]) {
    const history: Content[] = [];
    
    for (const turn of turns) {
      const parts: Part[] = [];
      
      if (turn.role === 'user') {
        if (turn.prompt) {
          parts.push({ text: turn.prompt });
        }
        if (turn.images) {
          for (const img of turn.images) {
            const base64 = img.dataUrl?.split(',')[1];
            if (base64) {
              parts.push({
                inlineData: {
                  mimeType: img.mimeType,
                  data: base64,
                }
              });
            }
          }
        }
      } else if (turn.role === 'model') {
        for (const output of turn.outputs) {
          if (output.type === 'text' && output.text) {
            // Include signature for text parts too
            const textPart: Record<string, unknown> = { text: output.text };
            if (output.signature) {
              textPart.thoughtSignature = output.signature;
            }
            parts.push(textPart as Part);
          } else if (output.type === 'image' && output.imageData) {
            let base64 = '';
            if (output.imageData.startsWith('data:')) {
              base64 = output.imageData.split(',')[1];
            } else if (output.storageId) {
              try {
                const response = await fetch(output.imageData);
                const blob = await response.blob();
                const reader = new FileReader();
                const dataUrl = await new Promise<string>((resolve) => {
                  reader.onloadend = () => resolve(reader.result as string);
                  reader.readAsDataURL(blob);
                });
                base64 = dataUrl.split(',')[1];
              } catch (e) {
                console.error('Failed to load image for history:', e);
              }
            }
            if (base64) {
              // MUST include thoughtSignature for model-generated images
              const imagePart: Record<string, unknown> = {
                inlineData: {
                  mimeType: output.mimeType || 'image/png',
                  data: base64,
                }
              };
              if (output.signature) {
                imagePart.thoughtSignature = output.signature;
              }
              parts.push(imagePart as Part);
            }
          }
        }
      }
      
      if (parts.length > 0) {
        history.push({ role: turn.role, parts });
      }
    }
    
    console.log('[DEBUG] Rebuilt conversation history:', JSON.stringify(
      history.map(c => ({
        role: c.role,
        parts: (c.parts || []).map((p) => {
          const part = p as Record<string, unknown>;
          return {
            hasText: !!part.text,
            hasImage: !!part.inlineData,
            hasSignature: !!part.thoughtSignature,
          };
        })
      })),
      null, 2
    ));
    
    setConversationHistory(history);
  }

  const duration = current.startTime && current.endTime
    ? ((current.endTime - current.startTime) / 1000).toFixed(1)
    : null;

  const lastModelTurn = [...conversation].reverse().find(t => t.role === 'model');
  const canSubmit = (input.trim() || uploadedImages.length > 0) && !current.isGenerating;

  return (
    <div className="studio">
      {/* Mobile menu toggle */}
      <button 
        className="mobile-menu-toggle"
        onClick={() => setSidebarOpen(!sidebarOpen)}
        aria-label="Toggle menu"
      >
        {sidebarOpen ? '✕' : '☰'}
      </button>
      
      {/* Sidebar overlay for mobile */}
      <div 
        className={`sidebar-overlay ${sidebarOpen ? 'visible' : ''}`}
        onClick={() => setSidebarOpen(false)}
      />
      
      <aside className={`sidebar ${sidebarOpen ? 'open' : ''}`}>
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
                  + New Session
                </button>
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
                    onClick={() => {
                      handleLoadSession(session);
                      setSidebarOpen(false);
                    }}
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

      <main 
        className={`workspace ${isDragging ? 'drag-active' : ''}`}
        onDragOver={handleDragOver}
        onDragEnter={handleDragEnter}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {/* Drag overlay */}
        {isDragging && (
          <div className="drag-overlay">
            <div className="drag-overlay-content">
              <span className="drag-icon">📷</span>
              <span className="drag-text">Drop images here</span>
              <span className="drag-hint">Up to {14 - uploadedImages.length} more images</span>
            </div>
          </div>
        )}
        
        <div className="conversation-area" ref={outputRef}>
          {conversation.length === 0 && current.phase === 'idle' && (
            <div className="empty-state">
              <div className="empty-icon">◈</div>
              <h2>Gemini 3 Pro Image</h2>
              <p>Generate and edit images with multi-turn conversation. Drag & drop, paste (Ctrl+V), or upload reference images.</p>
              <div className="feature-tags">
                <span className="feature-tag">Drag & Drop</span>
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
                    
                    {/* Version navigation for branched messages */}
                    {turn.versions && turn.versions.length > 0 && (
                      <div className="version-nav">
                        <button
                          type="button"
                          className="version-btn"
                          onClick={() => handleVersionChange(idx, 'prev')}
                          disabled={(turn.selectedVersion ?? turn.versions.length) === 0 || current.isGenerating}
                        >
                          ‹
                        </button>
                        <span className="version-indicator">
                          {(turn.selectedVersion ?? turn.versions.length) + 1} / {turn.versions.length + 1}
                        </span>
                        <button
                          type="button"
                          className="version-btn"
                          onClick={() => handleVersionChange(idx, 'next')}
                          disabled={(turn.selectedVersion ?? turn.versions.length) === turn.versions.length || current.isGenerating}
                        >
                          ›
                        </button>
                      </div>
                    )}
                    
                    {/* Edit and Delete buttons */}
                    <div className="message-actions">
                      {editingTurnIdx !== idx && (
                        <>
                          <button
                            type="button"
                            className="msg-action-btn edit"
                            onClick={() => handleStartEdit(idx)}
                            disabled={current.isGenerating}
                            title="Edit this message"
                          >
                            ✎
                          </button>
                          <button
                            type="button"
                            className="msg-action-btn delete"
                            onClick={() => handleDeleteTurn(idx)}
                            disabled={current.isGenerating}
                            title="Delete this turn"
                          >
                            ✕
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                  
                  {/* Edit mode UI */}
                  {editingTurnIdx === idx ? (
                    <div className="edit-mode">
                      <textarea
                        className="edit-textarea"
                        value={editInput}
                        onChange={(e) => setEditInput(e.target.value)}
                        placeholder="Edit your message..."
                        rows={3}
                      />
                      {editImages.length > 0 && (
                        <div className="edit-images">
                          {editImages.map((img, imgIdx) => (
                            <div key={imgIdx} className="edit-image-thumb">
                              {img.dataUrl && <img src={img.dataUrl} alt={img.name} />}
                              <button
                                type="button"
                                className="remove-edit-img"
                                onClick={() => setEditImages(prev => prev.filter((_, i) => i !== imgIdx))}
                              >
                                ×
                              </button>
                            </div>
                          ))}
                        </div>
                      )}
                      <div className="edit-actions">
                        <button
                          type="button"
                          className="edit-cancel-btn"
                          onClick={handleCancelEdit}
                        >
                          Cancel
                        </button>
                        <button
                          type="button"
                          className="edit-save-btn"
                          onClick={handleSaveEdit}
                          disabled={!editInput.trim() && editImages.length === 0}
                        >
                          Save & Regenerate
                        </button>
                      </div>
                    </div>
                  ) : (
                    <>
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
                    </>
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

                  {turn.outputs.map((output, oIdx) => {
                    // Find the user prompt that generated this image
                    const userTurnIdx = conversation.slice(0, idx).reverse().findIndex(t => t.role === 'user');
                    const userTurn = userTurnIdx !== -1 ? conversation[idx - 1 - userTurnIdx] : undefined;
                    const prompt = userTurn?.prompt;
                    
                    return (
                      <div key={oIdx} className="output-item">
                        {output.type === 'text' && output.text && <div className="response-text">{output.text}</div>}
                        {output.type === 'image' && output.imageData && (
                          <figure 
                            className="output-image clickable"
                            onClick={() => setLightbox({
                              imageData: output.imageData!,
                              prompt,
                              resolution: turn.resolution,
                              aspectRatio: turn.aspectRatio,
                              generationTime: turn.generationTime,
                              timestamp: turn.timestamp,
                            })}
                          >
                            <img src={output.imageData} alt={`Generated ${oIdx + 1}`} />
                            <figcaption>
                              <span className="image-meta">{turn.resolution} · {turn.aspectRatio}</span>
                              <div className="image-actions">
                                <button
                                  type="button"
                                  className="img-action-btn"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    openImageInNewTab(output.imageData!);
                                  }}
                                  title="Open in new tab"
                                >
                                  ↗ Open
                                </button>
                                <button
                                  type="button"
                                  className="img-action-btn"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    downloadImage(
                                      output.imageData!,
                                      `gemini-${turn.resolution}-${turn.aspectRatio.replace(':', 'x')}-${Date.now()}.webp`
                                    );
                                  }}
                                >
                                  ↓ Download
                                </button>
                                <button
                                  type="button"
                                  className="img-action-btn regen"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    handleRegenerate(idx);
                                  }}
                                  disabled={current.isGenerating}
                                  title="Regenerate this image"
                                >
                                  ↻ Regen
                                </button>
                              </div>
                            </figcaption>
                          </figure>
                        )}
                      </div>
                    );
                  })}
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

      {/* Image Lightbox Modal */}
      {lightbox && (
        <div className="lightbox-overlay" onClick={() => setLightbox(null)}>
          <div className="lightbox-content" onClick={(e) => e.stopPropagation()}>
            <button className="lightbox-close" onClick={() => setLightbox(null)}>×</button>
            <div className="lightbox-image-wrap">
              <img src={lightbox.imageData} alt="Full size" />
            </div>
            <div className="lightbox-info">
              {lightbox.prompt && (
                <div className="lightbox-prompt">
                  <span className="lightbox-label">PROMPT</span>
                  <p>{lightbox.prompt}</p>
                </div>
              )}
              <div className="lightbox-stats">
                <div className="stat">
                  <span className="stat-label">Resolution</span>
                  <span className="stat-value">{lightbox.resolution}</span>
                </div>
                <div className="stat">
                  <span className="stat-label">Aspect Ratio</span>
                  <span className="stat-value">{lightbox.aspectRatio}</span>
                </div>
                {lightbox.generationTime && (
                  <div className="stat">
                    <span className="stat-label">Gen Time</span>
                    <span className="stat-value">{(lightbox.generationTime / 1000).toFixed(1)}s</span>
                  </div>
                )}
                <div className="stat">
                  <span className="stat-label">Created</span>
                  <span className="stat-value">{lightbox.timestamp.toLocaleString()}</span>
                </div>
              </div>
              <button
                type="button"
                onClick={() => downloadImage(
                  lightbox.imageData,
                  `gemini-${lightbox.resolution}-${lightbox.aspectRatio.replace(':', 'x')}-${Date.now()}.webp`
                )}
                className="lightbox-download"
              >
                ↓ Download Full Size
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
