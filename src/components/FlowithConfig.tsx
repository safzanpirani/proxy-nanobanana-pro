import { useState, useEffect } from 'react';
import {
  FLOWITH_MODELS,
  type FlowithModel,
  type FlowithConfig as FlowithConfigType,
  extractUserIdFromToken,
  validateConfig,
  testConnection,
} from '../lib/flowith';

interface FlowithConfigProps {
  config: FlowithConfigType;
  onConfigChange: (config: FlowithConfigType) => void;
}

const STORAGE_KEY = 'flowith_config';

export function loadFlowithConfig(): FlowithConfigType {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      const parsed = JSON.parse(saved);
      return {
        token: parsed.token || '',
        userId: parsed.userId || '',
        model: parsed.model || 'gemini-3-pro-image',
      };
    }
  } catch {}
  
  return {
    token: '',
    userId: '',
    model: 'gemini-3-pro-image',
  };
}

export function saveFlowithConfig(config: FlowithConfigType): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
  } catch {}
}

export function FlowithConfig({ config, onConfigChange }: FlowithConfigProps) {
  const [showToken, setShowToken] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState<'idle' | 'testing' | 'connected' | 'error'>('idle');
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [autoExtractedUserId, setAutoExtractedUserId] = useState(false);

  useEffect(() => {
    if (config.token && !config.userId) {
      const extracted = extractUserIdFromToken(config.token);
      if (extracted) {
        onConfigChange({ ...config, userId: extracted });
        setAutoExtractedUserId(true);
        setTimeout(() => setAutoExtractedUserId(false), 2000);
      }
    }
  }, [config.token]);

  const handleTokenChange = (token: string) => {
    onConfigChange({ ...config, token });
    setConnectionStatus('idle');
    setConnectionError(null);
  };

  const handleUserIdChange = (userId: string) => {
    onConfigChange({ ...config, userId });
    setConnectionStatus('idle');
    setConnectionError(null);
  };

  const handleModelChange = (model: FlowithModel) => {
    onConfigChange({ ...config, model });
  };

  const handleExtractUserId = () => {
    const extracted = extractUserIdFromToken(config.token);
    if (extracted) {
      onConfigChange({ ...config, userId: extracted });
      setAutoExtractedUserId(true);
      setTimeout(() => setAutoExtractedUserId(false), 2000);
    }
  };

  const handleTestConnection = async () => {
    const validation = validateConfig(config);
    if (!validation.valid) {
      setConnectionStatus('error');
      setConnectionError(validation.error || 'Invalid configuration');
      return;
    }

    setConnectionStatus('testing');
    setConnectionError(null);

    const result = await testConnection(config as FlowithConfigType);
    
    if (result.success) {
      setConnectionStatus('connected');
      setConnectionError(null);
    } else {
      setConnectionStatus('error');
      setConnectionError(result.error || 'Connection failed');
    }
  };

  const isConfigValid = validateConfig(config).valid;

  return (
    <div className="flowith-config">
      <div className="config-section">
        <label className="config-label">JWT TOKEN</label>
        <div className="token-input-wrap">
          <input
            type={showToken ? 'text' : 'password'}
            className="token-input"
            value={config.token}
            onChange={(e) => handleTokenChange(e.target.value)}
            placeholder="eyJhbGciOiJSUzI1NiIs..."
            spellCheck={false}
          />
          <button
            type="button"
            className="token-toggle"
            onClick={() => setShowToken(!showToken)}
          >
            {showToken ? '◉' : '○'}
          </button>
        </div>
        <div className="config-hint">
          Get your token from Flowith dashboard → Developer → API Token
        </div>
      </div>

      <div className="config-section">
        <label className="config-label">USER ID</label>
        <div className="userid-input-wrap">
          <input
            type="text"
            className="userid-input"
            value={config.userId}
            onChange={(e) => handleUserIdChange(e.target.value)}
            placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
            spellCheck={false}
          />
          {config.token && !config.userId && (
            <button
              type="button"
              className="extract-userid-btn"
              onClick={handleExtractUserId}
              title="Extract from JWT"
            >
              ↻
            </button>
          )}
        </div>
        {autoExtractedUserId && (
          <div className="config-hint success">User ID extracted from token</div>
        )}
        <div className="config-hint">
          Found in JWT token's <code>sub</code> claim or your Flowith profile
        </div>
      </div>

      <div className="config-section">
        <label className="config-label">MODEL</label>
        <div className="model-selector">
          {FLOWITH_MODELS.map((model) => (
            <button
              key={model.value}
              type="button"
              className={`model-btn ${config.model === model.value ? 'active' : ''}`}
              onClick={() => handleModelChange(model.value)}
            >
              {model.label.replace('Gemini ', '').replace(' Image', '')}
            </button>
          ))}
        </div>
      </div>

      <div className="config-section">
        <label className="config-label">CONNECTION</label>
        <div className="connection-status-wrap">
          <div className={`connection-status ${connectionStatus}`}>
            <span className="status-dot"></span>
            <span className="status-text">
              {connectionStatus === 'idle' && 'Not tested'}
              {connectionStatus === 'testing' && 'Testing...'}
              {connectionStatus === 'connected' && 'Connected'}
              {connectionStatus === 'error' && 'Failed'}
            </span>
          </div>
          <button
            type="button"
            className="test-connection-btn"
            onClick={handleTestConnection}
            disabled={!isConfigValid || connectionStatus === 'testing'}
          >
            {connectionStatus === 'testing' ? '...' : 'Test'}
          </button>
        </div>
        {connectionError && (
          <div className="connection-error">{connectionError}</div>
        )}
      </div>
    </div>
  );
}
