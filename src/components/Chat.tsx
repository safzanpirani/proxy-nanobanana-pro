import { useState, useRef, useEffect, type FormEvent } from 'react';
import { client, MODEL_ID, ASPECT_RATIOS, RESOLUTIONS, parseResponseParts, Modality, type AspectRatio, type Resolution, type ThoughtPart, type OutputPart, type Content } from '../lib/ai';

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
  thoughts: ThoughtPart[];
  outputs: OutputPart[];
  aspectRatio: AspectRatio;
  resolution: Resolution;
  timestamp: Date;
}

export function Chat() {
  const [input, setInput] = useState('');
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

  const thoughtRef = useRef<HTMLPreElement>(null);
  const outputRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (thoughtRef.current && current.phase === 'thinking') {
      thoughtRef.current.scrollTop = thoughtRef.current.scrollHeight;
    }
  }, [current.thoughts, current.phase]);

  useEffect(() => {
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [conversation]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!input.trim() || current.isGenerating) return;

    const prompt = input.trim();
    setInput('');
    const startTime = Date.now();

    setConversation(prev => [...prev, {
      role: 'user',
      prompt,
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
      phase: 'thinking',
      startTime,
    });

    try {
      const contents: Content[] = [
        ...conversationHistory,
        { role: 'user', parts: [{ text: prompt }] },
      ];

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
      const parsed = parseResponseParts(parts);

      setCurrent({
        thoughts: parsed.thoughts,
        outputs: parsed.outputs,
        isGenerating: false,
        phase: 'done',
        startTime,
        endTime,
      });

      setConversation(prev => [...prev, {
        role: 'model',
        thoughts: parsed.thoughts,
        outputs: parsed.outputs,
        aspectRatio,
        resolution,
        timestamp: new Date(),
      }]);

      const modelContent: Content = {
        role: 'model',
        parts: parts.filter(p => {
          const raw = p as Record<string, unknown>;
          return raw.thought !== true;
        }),
      };

      setConversationHistory(prev => [
        ...prev,
        { role: 'user', parts: [{ text: prompt }] },
        modelContent,
      ]);

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      setCurrent(prev => ({
        ...prev,
        isGenerating: false,
        phase: 'done',
        error: errorMessage,
      }));
    }
  }

  function handleNewConversation() {
    setConversation([]);
    setConversationHistory([]);
    setCurrent({
      thoughts: [],
      outputs: [],
      isGenerating: false,
      phase: 'idle',
    });
  }

  const duration = current.startTime && current.endTime
    ? ((current.endTime - current.startTime) / 1000).toFixed(1)
    : null;

  const lastModelTurn = [...conversation].reverse().find(t => t.role === 'model');

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

        {conversation.length > 0 && (
          <div className="config-section">
            <label className="config-label">CONVERSATION</label>
            <div className="conv-info">
              <span className="conv-count">{Math.ceil(conversation.length / 2)} turn{conversation.length > 2 ? 's' : ''}</span>
              <button type="button" onClick={handleNewConversation} className="new-conv-btn">
                New
              </button>
            </div>
          </div>
        )}
      </aside>

      <main className="workspace">
        <div className="conversation-area" ref={outputRef}>
          {conversation.length === 0 && current.phase === 'idle' && (
            <div className="empty-state">
              <div className="empty-icon">◈</div>
              <h2>Gemini 3 Pro Image</h2>
              <p>Generate and edit images with multi-turn conversation. Watch the model's thinking process as it reasons through your prompts.</p>
              <div className="feature-tags">
                <span className="feature-tag">Multi-Turn Editing</span>
                <span className="feature-tag">Thinking Mode</span>
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
                  <div className="message-content">{turn.prompt}</div>
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
                            {thought.type === 'thought-text' && (
                              <pre className="thinking-content">{thought.text}</pre>
                            )}
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
                      {output.type === 'text' && output.text && (
                        <div className="response-text">{output.text}</div>
                      )}
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
                {current.phase === 'thinking' ? 'THINKING...' : 'GENERATING...'}
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
              Continue editing the image above, or describe a new one
            </div>
          )}
          <div className="input-wrapper">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  handleSubmit(e);
                }
              }}
              placeholder={conversation.length > 0 ? "Describe your edit..." : "Describe your vision..."}
              disabled={current.isGenerating}
              className="prompt-input"
              rows={2}
            />
            <div className="input-actions">
              <button type="submit" disabled={!input.trim() || current.isGenerating} className="btn btn-generate">
                <span className="btn-icon">→</span>
                {current.isGenerating ? 'GENERATING...' : conversation.length > 0 ? 'EDIT' : 'GENERATE'}
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
