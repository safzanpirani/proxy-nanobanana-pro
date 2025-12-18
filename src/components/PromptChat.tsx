import { useState, useRef, useEffect, useCallback, type FormEvent, type ChangeEvent, type ClipboardEvent, type ReactNode, type RefObject } from 'react';
import { Streamdown } from 'streamdown';
import type { Components } from 'react-markdown';
import { streamChatMessage, createChatMessage, QUICK_PROMPTS, type ChatMessage, type ToolCall } from '../lib/promptChat';
import { loadFlowithConfig } from './FlowithConfig';

const CHAT_HISTORY_KEY = 'prompt-chat-history';
const MAX_SAVED_SESSIONS = 10;

interface ChatSession {
  id: string;
  name: string;
  messages: ChatMessage[];
  updatedAt: Date;
}

interface PromptChatProps {
  onUsePrompt?: (prompt: string) => void;
  onClose?: () => void;
}

function CopyButton({ 
  text, 
  textRef, 
  className = '' 
}: { 
  text?: string; 
  textRef?: RefObject<HTMLElement | null>; 
  className?: string 
}) {
  const [copied, setCopied] = useState(false);
  
  const handleCopy = useCallback(async () => {
    try {
      const textToCopy = textRef?.current?.textContent || text || '';
      await navigator.clipboard.writeText(textToCopy);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  }, [text, textRef]);
  
  return (
    <button
      type="button"
      className={`copy-btn ${copied ? 'copied' : ''} ${className}`}
      onClick={handleCopy}
      title={copied ? 'Copied!' : 'Copy to clipboard'}
    >
      {copied ? '✓' : '⧉'}
    </button>
  );
}

function CodeBlock({ children, className }: { children?: ReactNode; className?: string }) {
  const language = className?.replace('language-', '') || '';
  const codeRef = useRef<HTMLElement>(null);
  
  return (
    <div className="code-block-wrapper">
      <div className="code-block-header">
        {language && <span className="code-language">{language}</span>}
        <CopyButton textRef={codeRef} />
      </div>
      <pre className={className}>
        <code ref={codeRef} className={className}>{children}</code>
      </pre>
    </div>
  );
}

function InlineCode({ children }: { children?: ReactNode }) {
  return <code className="inline-code">{children}</code>;
}

function Blockquote({ children }: { children?: ReactNode }) {
  const quoteRef = useRef<HTMLDivElement>(null);
  
  return (
    <blockquote className="blockquote-wrapper">
      <div ref={quoteRef} className="blockquote-content">{children}</div>
      <CopyButton textRef={quoteRef} className="blockquote-copy" />
    </blockquote>
  );
}

const markdownComponents: Components = {
  pre: ({ children }) => <>{children}</>,
  code: ({ children, className }) => {
    const isBlock = className?.includes('language-') || 
      (typeof children === 'string' && children.includes('\n'));
    
    if (isBlock) {
      return <CodeBlock className={className}>{children}</CodeBlock>;
    }
    return <InlineCode>{children}</InlineCode>;
  },
  blockquote: ({ children }) => <Blockquote>{children}</Blockquote>,
};

function loadSessions(): ChatSession[] {
  try {
    const stored = localStorage.getItem(CHAT_HISTORY_KEY);
    if (!stored) return [];
    const sessions = JSON.parse(stored);
    return sessions.map((s: ChatSession) => ({
      ...s,
      updatedAt: new Date(s.updatedAt),
      messages: s.messages.map((m: ChatMessage) => ({
        ...m,
        timestamp: new Date(m.timestamp),
      })),
    }));
  } catch {
    return [];
  }
}

function saveSessions(sessions: ChatSession[]) {
  try {
    const toSave = sessions.slice(0, MAX_SAVED_SESSIONS);
    localStorage.setItem(CHAT_HISTORY_KEY, JSON.stringify(toSave));
  } catch (err) {
    console.error('Failed to save chat sessions:', err);
  }
}

export function PromptChat({ onUsePrompt, onClose }: PromptChatProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [images, setImages] = useState<Array<{ id: string; dataUrl: string; mimeType: string }>>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [streamingContent, setStreamingContent] = useState('');
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [generatingImages, setGeneratingImages] = useState(false);
  const [pendingToolCall, setPendingToolCall] = useState<ToolCall | null>(null);
  
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const shouldAutoScroll = useRef(true);
  
  useEffect(() => {
    setSessions(loadSessions());
  }, []);
  
  const scrollToBottom = useCallback(() => {
    if (!shouldAutoScroll.current || !messagesContainerRef.current) return;
    const container = messagesContainerRef.current;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        container.scrollTop = container.scrollHeight;
      });
    });
  }, []);
  
  useEffect(() => {
    scrollToBottom();
  }, [messages, streamingContent, generatingImages, scrollToBottom]);
  
  const handleScroll = useCallback(() => {
    if (!messagesContainerRef.current) return;
    const container = messagesContainerRef.current;
    const isAtBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 100;
    shouldAutoScroll.current = isAtBottom;
  }, []);
  
  useEffect(() => {
    textareaRef.current?.focus();
  }, []);
  
  const saveCurrentSession = useCallback((updatedMessages: ChatMessage[]) => {
    if (updatedMessages.length === 0) return;
    
    const sessionName = updatedMessages[0].content.slice(0, 40) + (updatedMessages[0].content.length > 40 ? '...' : '');
    
    setSessions(prev => {
      let updated: ChatSession[];
      if (currentSessionId) {
        updated = prev.map(s => 
          s.id === currentSessionId 
            ? { ...s, messages: updatedMessages, updatedAt: new Date(), name: sessionName }
            : s
        );
      } else {
        const newId = `session-${Date.now()}`;
        setCurrentSessionId(newId);
        updated = [
          { id: newId, name: sessionName, messages: updatedMessages, updatedAt: new Date() },
          ...prev,
        ];
      }
      saveSessions(updated);
      return updated;
    });
  }, [currentSessionId]);
  
  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if ((!input.trim() && images.length === 0) || isLoading) return;
    
    shouldAutoScroll.current = true;
    
    const userContent = input.trim();
    const userImages = images.map(img => ({ dataUrl: img.dataUrl, mimeType: img.mimeType }));
    
    const userMessage = createChatMessage('user', userContent, userImages.length > 0 ? userImages : undefined);
    const newMessages = [...messages, userMessage];
    setMessages(newMessages);
    setInput('');
    setImages([]);
    setIsLoading(true);
    setError(null);
    setStreamingContent('');
    setPendingToolCall(null);
    
    try {
      const flowithConfig = loadFlowithConfig();
      
      const result = await streamChatMessage(
        userContent, 
        userImages, 
        messages,
        (text) => {
          setStreamingContent(text);
        },
        {
          flowithConfig: flowithConfig || undefined,
          onToolCall: (toolCall) => {
            setPendingToolCall(toolCall);
            setGeneratingImages(true);
          },
          onToolResult: () => {
            setGeneratingImages(false);
            setPendingToolCall(null);
          },
        }
      );
      
      const assistantMessage = createChatMessage(
        'assistant', 
        result.content,
        undefined,
        result.toolCalls,
        result.toolResults
      );
      const finalMessages = [...newMessages, assistantMessage];
      setMessages(finalMessages);
      setStreamingContent('');
      saveCurrentSession(finalMessages);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Failed to get response';
      setError(errorMsg);
      setStreamingContent('');
    } finally {
      setIsLoading(false);
      setGeneratingImages(false);
      setPendingToolCall(null);
    }
  }
  
  function handleQuickPrompt(promptTemplate: string) {
    setInput(prev => prev ? `${promptTemplate} "${prev}"` : promptTemplate + ' ');
    textareaRef.current?.focus();
  }
  
  function handleUsePrompt(content: string) {
    const codeBlockMatch = content.match(/```(?:\w+)?\n?([\s\S]*?)```/);
    const promptText = codeBlockMatch ? codeBlockMatch[1].trim() : content;
    onUsePrompt?.(promptText);
  }
  
  async function handleFileSelect(e: ChangeEvent<HTMLInputElement>) {
    const files = e.target.files;
    if (!files) return;
    
    for (const file of Array.from(files)) {
      if (!file.type.startsWith('image/') || images.length >= 4) continue;
      
      const reader = new FileReader();
      const dataUrl = await new Promise<string>((resolve) => {
        reader.onload = () => resolve(reader.result as string);
        reader.readAsDataURL(file);
      });
      
      setImages(prev => [...prev, {
        id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        dataUrl,
        mimeType: file.type,
      }]);
    }
    
    if (fileInputRef.current) fileInputRef.current.value = '';
  }
  
  async function handlePaste(e: ClipboardEvent) {
    const items = e.clipboardData?.items;
    if (!items) return;
    
    for (const item of Array.from(items)) {
      if (item.type.startsWith('image/') && images.length < 4) {
        e.preventDefault();
        const file = item.getAsFile();
        if (!file) continue;
        
        const reader = new FileReader();
        const dataUrl = await new Promise<string>((resolve) => {
          reader.onload = () => resolve(reader.result as string);
          reader.readAsDataURL(file);
        });
        
        setImages(prev => [...prev, {
          id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
          dataUrl,
          mimeType: file.type,
        }]);
      }
    }
  }
  
  function removeImage(id: string) {
    setImages(prev => prev.filter(img => img.id !== id));
  }
  
  function handleNewChat() {
    setMessages([]);
    setCurrentSessionId(null);
    setError(null);
    setStreamingContent('');
    setShowHistory(false);
  }
  
  function handleLoadSession(session: ChatSession) {
    setMessages(session.messages);
    setCurrentSessionId(session.id);
    setError(null);
    setStreamingContent('');
    setShowHistory(false);
  }
  
  function handleDeleteSession(sessionId: string) {
    setSessions(prev => {
      const updated = prev.filter(s => s.id !== sessionId);
      saveSessions(updated);
      return updated;
    });
    if (currentSessionId === sessionId) {
      setMessages([]);
      setCurrentSessionId(null);
    }
  }
  
  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e);
    }
  }
  
  return (
    <div className="prompt-chat">
      <div className="prompt-chat-header">
        <div className="prompt-chat-title">
          <span className="prompt-chat-icon">💬</span>
          <span>Prompt Assistant</span>
        </div>
        <div className="prompt-chat-actions">
          <button 
            className={`prompt-chat-history-btn ${showHistory ? 'active' : ''}`} 
            onClick={() => setShowHistory(!showHistory)} 
            title="Chat history"
          >
            📜 {sessions.length > 0 && <span className="history-count">{sessions.length}</span>}
          </button>
          <button className="prompt-chat-new" onClick={handleNewChat} title="New chat">
            + New
          </button>
          {onClose && (
            <button className="prompt-chat-close" onClick={onClose} title="Close">
              ✕
            </button>
          )}
        </div>
      </div>
      
      {showHistory && (
        <div className="prompt-chat-history-panel">
          <div className="history-panel-header">
            <span>Chat History</span>
            <button onClick={() => setShowHistory(false)}>✕</button>
          </div>
          {sessions.length === 0 ? (
            <div className="history-empty">No saved chats yet</div>
          ) : (
            <div className="history-list">
              {sessions.map(session => (
                <div 
                  key={session.id} 
                  className={`history-item ${currentSessionId === session.id ? 'active' : ''}`}
                >
                  <button 
                    className="history-item-main"
                    onClick={() => handleLoadSession(session)}
                  >
                    <span className="history-name">{session.name}</span>
                    <span className="history-meta">
                      {session.messages.length} msgs · {new Date(session.updatedAt).toLocaleDateString()}
                    </span>
                  </button>
                  <button 
                    className="history-delete"
                    onClick={() => handleDeleteSession(session.id)}
                    title="Delete"
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      
      <div 
        className="prompt-chat-messages" 
        ref={messagesContainerRef}
        onScroll={handleScroll}
      >
        {messages.length === 0 && !streamingContent && (
          <div className="prompt-chat-empty">
            <div className="prompt-chat-empty-icon">✨</div>
            <h3>Prompt Assistant</h3>
            <p>I can help you create, edit, and improve image prompts. Upload an image for analysis or describe what you want to create.</p>
            <div className="quick-prompts">
              {QUICK_PROMPTS.map((qp, idx) => (
                <button
                  key={idx}
                  className="quick-prompt-btn"
                  onClick={() => handleQuickPrompt(qp.prompt)}
                >
                  {qp.label}
                </button>
              ))}
            </div>
          </div>
        )}
        
        {messages.map((msg) => (
          <div key={msg.id} className={`prompt-chat-message ${msg.role}`}>
            <div className="message-role">
              {msg.role === 'user' ? 'You' : 'Assistant'}
            </div>
            <div className="message-body">
              {msg.images && msg.images.length > 0 && (
                <div className="message-images">
                  {msg.images.map((img, idx) => (
                    <img key={idx} src={img.dataUrl} alt={`Uploaded ${idx + 1}`} />
                  ))}
                </div>
              )}
              <div className="message-text markdown-content">
                {msg.role === 'assistant' ? (
                  <Streamdown components={markdownComponents}>{msg.content}</Streamdown>
                ) : (
                  msg.content
                )}
              </div>
              {msg.toolResults && msg.toolResults.length > 0 && (
                <div className="tool-results">
                  {msg.toolResults.map((tr, idx) => (
                    <div key={idx} className="tool-result">
                      <div className="tool-result-header">
                        <span className="tool-icon">🖼️</span>
                        <span className="tool-name">Generated Images</span>
                        <span className="tool-params">
                          {tr.result.params.aspectRatio} · {tr.result.params.resolution} · {tr.result.params.count}x
                        </span>
                      </div>
                      {tr.result.success && tr.result.images && (
                        <div className="generated-images-grid">
                          {tr.result.images.map((img, imgIdx) => (
                            <a 
                              key={imgIdx} 
                              href={img.url || img.dataUrl} 
                              target="_blank" 
                              rel="noopener noreferrer"
                              className="generated-image-link"
                            >
                              <img src={img.url || img.dataUrl} alt={`Generated ${imgIdx + 1}`} onLoad={scrollToBottom} />
                            </a>
                          ))}
                        </div>
                      )}
                      {!tr.result.success && (
                        <div className="tool-error">
                          ⚠️ {tr.result.error}
                        </div>
                      )}
                      {tr.result.error && tr.result.success && (
                        <div className="tool-warning">
                          ⚠️ {tr.result.error}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
              {msg.role === 'assistant' && onUsePrompt && (
                <div className="message-actions-row">
                  <CopyButton text={msg.content} />
                  <button
                    type="button"
                    className="use-prompt-small-btn"
                    onClick={() => handleUsePrompt(msg.content)}
                    title="Use in image generator"
                  >
                    ↗
                  </button>
                </div>
              )}
            </div>
          </div>
        ))}
        
        {streamingContent && (
          <div className="prompt-chat-message assistant streaming">
            <div className="message-role">Assistant</div>
            <div className="message-body">
              <div className="message-text markdown-content">
                <Streamdown 
                  isAnimating={true} 
                  parseIncompleteMarkdown={true}
                  components={markdownComponents}
                >
                  {streamingContent}
                </Streamdown>
              </div>
            </div>
          </div>
        )}
        
        {generatingImages && pendingToolCall && (
          <div className="prompt-chat-message assistant generating">
            <div className="message-role">Generating</div>
            <div className="message-body">
              <div className="generating-indicator">
                <span className="generating-icon">🖼️</span>
                <span className="generating-text">
                  Generating images with Flowith...
                </span>
                <div className="generating-params">
                  {(pendingToolCall.args as { aspect_ratio?: string }).aspect_ratio || '1:1'} · 
                  {(pendingToolCall.args as { resolution?: string }).resolution || '2k'} · 
                  {(pendingToolCall.args as { count?: number }).count || 1}x
                </div>
              </div>
            </div>
          </div>
        )}
        
        {isLoading && !streamingContent && !generatingImages && (
          <div className="prompt-chat-message assistant loading">
            <div className="message-role">Assistant</div>
            <div className="message-body">
              <div className="typing-indicator">
                <span></span><span></span><span></span>
              </div>
            </div>
          </div>
        )}
        
        {error && (
          <div className="prompt-chat-error">
            <span className="error-icon">⚠</span>
            {error}
          </div>
        )}
      </div>
      
      <form className="prompt-chat-input-form" onSubmit={handleSubmit}>
        {images.length > 0 && (
          <div className="prompt-chat-images">
            {images.map(img => (
              <div key={img.id} className="prompt-chat-image-preview">
                <img src={img.dataUrl} alt="Upload preview" />
                <button type="button" onClick={() => removeImage(img.id)}>✕</button>
              </div>
            ))}
          </div>
        )}
        
        <div className="prompt-chat-input-row">
          <button
            type="button"
            className="prompt-chat-upload"
            onClick={() => fileInputRef.current?.click()}
            disabled={isLoading || images.length >= 4}
            title="Upload image (max 4)"
          >
            📎
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
            onChange={e => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            placeholder="Ask about prompts, paste an image, or describe what you want to create..."
            rows={1}
          />
          <button
            type="submit"
            className="prompt-chat-send"
            disabled={isLoading || (!input.trim() && images.length === 0)}
          >
            {isLoading ? '◐' : '→'}
          </button>
        </div>
      </form>
    </div>
  );
}
