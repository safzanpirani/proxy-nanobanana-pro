/**
 * Flowith API Client for Image Generation
 * 
 * Supports:
 * - Image upload to /file/store
 * - Async image generation via /image_gen/async
 * - SSE stream for results
 * - Batch generation (parallel async calls)
 */

export const FLOWITH_MODELS = [
  { value: 'gemini-2.5-flash-image', label: 'Gemini 2.5 Flash Image' },
  { value: 'gemini-3-flash-image', label: 'Gemini 3 Flash Image' },
  { value: 'gemini-3-pro-image', label: 'Gemini 3 Pro Image' },
] as const;

export type FlowithModel = typeof FLOWITH_MODELS[number]['value'];

export const FLOWITH_ASPECT_RATIOS = ['1:1', '3:2', '2:3', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'] as const;
export type FlowithAspectRatio = typeof FLOWITH_ASPECT_RATIOS[number];

export const FLOWITH_IMAGE_SIZES = ['1k', '2k', '4k'] as const;
export type FlowithImageSize = typeof FLOWITH_IMAGE_SIZES[number];

const FLOWITH_BASE_URL = 'https://edge.flowith.net';

function getAuthHeader(token: string): string {
  if (token.startsWith('Bearer ')) {
    return token;
  }
  return `Bearer ${token}`;
}

export interface FlowithConfig {
  token: string;
  userId: string;
  model: FlowithModel;
}

export interface FlowithGenerateParams {
  prompt: string;
  aspectRatio: FlowithAspectRatio;
  imageSize: FlowithImageSize;
  images?: Array<{ url: string; filename: string }>;
  conversationHistory?: FlowithMessage[];
}

export interface FlowithMessage {
  content: string;
  role: 'user' | 'assistant';
}

export interface FlowithSSEEvent {
  type?: string;
  taskType?: string;
  nodeId?: string;
  convId?: string;
  status?: string;
  result?: string;
  error?: string;
  error_type?: FlowithErrorType;
  isPaid?: boolean;
  timestamp?: number;
  heartbeat?: number;
  sender?: string;
}

export type FlowithErrorType = 'content_policy' | 'provider_error' | 'rate_limit' | 'timeout' | 'unknown';

export interface FlowithGenerationResult {
  nodeId: string;
  status: 'completed' | 'error';
  imageUrl?: string;
  error?: string;
  errorType?: FlowithErrorType;
  generationTime: number;
}

export function getFlowithErrorMessage(errorType?: FlowithErrorType, rawError?: string): string {
  switch (errorType) {
    case 'content_policy':
      return 'Content flagged as sensitive. Try different prompts or images.';
    case 'provider_error':
      return 'Generation failed. The AI could not produce an image. Try again.';
    case 'rate_limit':
      return 'Rate limit exceeded. Please wait a moment and try again.';
    case 'timeout':
      return 'Generation timed out. Try a simpler prompt or lower resolution.';
    default:
      return rawError || 'An unknown error occurred.';
  }
}

/**
 * Extract user_id from JWT token's sub claim
 */
export function extractUserIdFromToken(token: string): string | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    
    const payload = JSON.parse(atob(parts[1]));
    return payload.sub || null;
  } catch {
    return null;
  }
}

/**
 * Upload an image file to Flowith's file storage
 */
export async function uploadImage(file: File, token: string): Promise<string> {
  const formData = new FormData();
  formData.append('file', file, file.name);

  const response = await fetch(`${FLOWITH_BASE_URL}/file/store`, {
    method: 'POST',
    headers: {
      'Authorization': getAuthHeader(token),
    },
    body: formData,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Upload failed: ${response.status} ${response.statusText} - ${text}`);
  }

  const result = await response.json();
  return result.url;
}

/**
 * Upload a base64 data URL image to Flowith
 */
export async function uploadImageFromDataUrl(
  dataUrl: string, 
  filename: string, 
  token: string
): Promise<string> {
  // Convert data URL to Blob
  const [header, base64] = dataUrl.split(',');
  const mimeMatch = header.match(/:(.*?);/);
  const mimeType = mimeMatch ? mimeMatch[1] : 'image/png';
  
  const binary = atob(base64);
  const array = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    array[i] = binary.charCodeAt(i);
  }
  
  const blob = new Blob([array], { type: mimeType });
  const file = new File([blob], filename, { type: mimeType });
  
  return uploadImage(file, token);
}

/**
 * Build message content with markdown image references
 */
function buildMessageContent(
  prompt: string, 
  images?: Array<{ url: string; filename: string }>
): string {
  if (!images || images.length === 0) {
    return prompt;
  }
  
  const imageMarkdown = images
    .map(img => `![${img.filename}](${img.url})`)
    .join('\n');
  
  return `${prompt}\n\n${imageMarkdown}`;
}

/**
 * Generate a single image via Flowith API with SSE
 */
export async function generateImage(
  config: FlowithConfig,
  params: FlowithGenerateParams,
  onProgress?: (event: 'connected' | 'heartbeat' | 'processing') => void
): Promise<FlowithGenerationResult> {
  const nodeId = crypto.randomUUID();
  const convId = crypto.randomUUID();
  const startTime = Date.now();

  // Build message content with image markdown
  const messageContent = buildMessageContent(params.prompt, params.images);

  // Create abort controller for SSE
  const abortController = new AbortController();
  
  // Set up timeout - minimum 5 minutes, 7 minutes for 4K
  const timeoutMs = params.imageSize === '4k' ? 420000 : 300000;
  const timeout = setTimeout(() => {
    abortController.abort();
  }, timeoutMs);

  try {
    // Start SSE connection first
    const sseUrl = `${FLOWITH_BASE_URL}/user_stream/sse?user_id=${config.userId}`;
    
    const resultPromise = new Promise<FlowithGenerationResult>((resolve, reject) => {
      fetch(sseUrl, {
        headers: { 'Authorization': getAuthHeader(config.token) },
        signal: abortController.signal,
      }).then(async (response) => {
        if (!response.ok) {
          reject(new Error(`SSE connection failed: ${response.status}`));
          return;
        }

        const reader = response.body?.getReader();
        if (!reader) {
          reject(new Error('No response body'));
          return;
        }

        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            if (line.startsWith('data: ')) {
              try {
                const json: FlowithSSEEvent = JSON.parse(line.slice(6));

                if (json.heartbeat) {
                  onProgress?.('heartbeat');
                  continue;
                }

                if (json.status === 'connected') {
                  onProgress?.('connected');
                  continue;
                }

                if (json.type === 'workflow_complete' && json.nodeId === nodeId) {
                  clearTimeout(timeout);
                  reader.cancel();

                  if (json.status === 'completed' && json.result) {
                    resolve({
                      nodeId,
                      status: 'completed',
                      imageUrl: json.result,
                      generationTime: Date.now() - startTime,
                    });
                  } else {
                    resolve({
                      nodeId,
                      status: 'error',
                      error: json.error || `Generation failed: ${json.status}`,
                      errorType: json.error_type || 'unknown',
                      generationTime: Date.now() - startTime,
                    });
                  }
                  return;
                }
              } catch {
                // Not valid JSON, ignore
              }
            }
          }
        }
      }).catch((err) => {
        if (err.name === 'AbortError') {
          reject(new Error('Generation timed out'));
        } else {
          reject(err);
        }
      });
    });

    // Small delay to ensure SSE is connected
    await new Promise(r => setTimeout(r, 500));
    onProgress?.('processing');

    // Fire async generation request
    const genResponse = await fetch(`${FLOWITH_BASE_URL}/image_gen/async`, {
      method: 'POST',
      headers: {
        'Authorization': getAuthHeader(config.token),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: config.model,
        nodeId,
        convId,
        aspect_ratio: params.aspectRatio,
        image_size: params.imageSize,
        messages: [
          ...(params.conversationHistory || []),
          { content: messageContent, role: 'user' }
        ],
      }),
    });

    if (!genResponse.ok) {
      clearTimeout(timeout);
      abortController.abort();
      const errorText = await genResponse.text();
      return {
        nodeId,
        status: 'error',
        error: `API error ${genResponse.status}: ${errorText}`,
        generationTime: Date.now() - startTime,
      };
    }

    const genResult = await genResponse.json();

    if (genResult.status !== 'processing') {
      clearTimeout(timeout);
      abortController.abort();
      return {
        nodeId,
        status: 'error',
        error: `Unexpected response: ${JSON.stringify(genResult)}`,
        generationTime: Date.now() - startTime,
      };
    }

    // Wait for SSE result
    return await resultPromise;

  } catch (error) {
    clearTimeout(timeout);
    return {
      nodeId,
      status: 'error',
      error: error instanceof Error ? error.message : 'Unknown error',
      generationTime: Date.now() - startTime,
    };
  }
}

/**
 * Generate multiple images in parallel (batch)
 */
export async function generateBatch(
  config: FlowithConfig,
  params: FlowithGenerateParams,
  count: number,
  onProgress?: (index: number, event: 'started' | 'completed' | 'error', result?: FlowithGenerationResult) => void
): Promise<FlowithGenerationResult[]> {
  const convId = crypto.randomUUID();
  const nodeIds: string[] = Array.from({ length: count }, () => crypto.randomUUID());
  const startTime = Date.now();

  // Build message content
  const messageContent = buildMessageContent(params.prompt, params.images);

  // Track pending results
  const pendingNodeIds = new Set(nodeIds);
  const results = new Map<string, FlowithGenerationResult>();

  // Create abort controller
  const abortController = new AbortController();

  // Set up timeout - minimum 5 minutes, 7 minutes for 4K
  const timeoutMs = params.imageSize === '4k' ? 420000 : 300000;
  const timeout = setTimeout(() => {
    abortController.abort();
  }, timeoutMs);

  try {
    // Start SSE connection
    const sseUrl = `${FLOWITH_BASE_URL}/user_stream/sse?user_id=${config.userId}`;

    const batchPromise = new Promise<Map<string, FlowithGenerationResult>>((resolve, reject) => {
      fetch(sseUrl, {
        headers: { 'Authorization': getAuthHeader(config.token) },
        signal: abortController.signal,
      }).then(async (response) => {
        if (!response.ok) {
          reject(new Error(`SSE connection failed: ${response.status}`));
          return;
        }

        const reader = response.body?.getReader();
        if (!reader) {
          reject(new Error('No response body'));
          return;
        }

        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            if (line.startsWith('data: ')) {
              try {
                const json: FlowithSSEEvent = JSON.parse(line.slice(6));

                if (json.type === 'workflow_complete' && json.nodeId && pendingNodeIds.has(json.nodeId)) {
                  const nodeId = json.nodeId;
                  pendingNodeIds.delete(nodeId);

                  const result: FlowithGenerationResult = json.status === 'completed' && json.result
                    ? {
                        nodeId,
                        status: 'completed',
                        imageUrl: json.result,
                        generationTime: Date.now() - startTime,
                      }
                    : {
                        nodeId,
                        status: 'error',
                        error: json.error || `Generation failed: ${json.status}`,
                        errorType: json.error_type || 'unknown',
                        generationTime: Date.now() - startTime,
                      };

                  results.set(nodeId, result);

                  const index = nodeIds.indexOf(nodeId);
                  onProgress?.(index, result.status === 'completed' ? 'completed' : 'error', result);

                  if (pendingNodeIds.size === 0) {
                    clearTimeout(timeout);
                    reader.cancel();
                    resolve(results);
                    return;
                  }
                }
              } catch {
                // Not valid JSON, ignore
              }
            }
          }
        }
      }).catch((err) => {
        if (err.name === 'AbortError') {
          reject(new Error('Batch generation timed out'));
        } else {
          reject(err);
        }
      });
    });

    // Small delay for SSE connection
    await new Promise(r => setTimeout(r, 500));

    // Fire all async requests in parallel
    const requests = nodeIds.map((nodeId, index) => {
      onProgress?.(index, 'started');
      
      return fetch(`${FLOWITH_BASE_URL}/image_gen/async`, {
        method: 'POST',
        headers: {
          'Authorization': getAuthHeader(config.token),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: config.model,
          nodeId,
          convId,
          aspect_ratio: params.aspectRatio,
          image_size: params.imageSize,
          messages: [
            ...(params.conversationHistory || []),
            { content: messageContent, role: 'user' }
          ],
        }),
      }).then(r => r.json());
    });

    await Promise.all(requests);

    // Wait for all SSE results
    const resultsMap = await batchPromise;
    
    // Return results in order
    return nodeIds.map(id => resultsMap.get(id) || {
      nodeId: id,
      status: 'error' as const,
      error: 'No result received',
      generationTime: Date.now() - startTime,
    });

  } catch (error) {
    clearTimeout(timeout);
    
    // Return partial results
    return nodeIds.map(id => results.get(id) || {
      nodeId: id,
      status: 'error' as const,
      error: error instanceof Error ? error.message : 'Unknown error',
      generationTime: Date.now() - startTime,
    });
  }
}

/**
 * Validate Flowith configuration
 */
export function validateConfig(config: Partial<FlowithConfig>): { valid: boolean; error?: string } {
  if (!config.token || config.token.trim() === '') {
    return { valid: false, error: 'JWT Token is required' };
  }

  if (!config.userId || config.userId.trim() === '') {
    return { valid: false, error: 'User ID is required' };
  }

  // Basic JWT format check
  const parts = config.token.split('.');
  if (parts.length !== 3) {
    return { valid: false, error: 'Invalid JWT Token format' };
  }

  // UUID format check for userId
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(config.userId)) {
    return { valid: false, error: 'Invalid User ID format (should be UUID)' };
  }

  return { valid: true };
}

/**
 * Test Flowith connection by connecting to SSE briefly
 */
export async function testConnection(config: FlowithConfig): Promise<{ success: boolean; error?: string }> {
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), 10000);

  try {
    const response = await fetch(
      `${FLOWITH_BASE_URL}/user_stream/sse?user_id=${config.userId}`,
      {
        headers: { 'Authorization': getAuthHeader(config.token) },
        signal: abortController.signal,
      }
    );

    clearTimeout(timeout);

    if (!response.ok) {
      return { success: false, error: `HTTP ${response.status}: ${response.statusText}` };
    }

    // Read first event to verify connection
    const reader = response.body?.getReader();
    if (!reader) {
      return { success: false, error: 'No response body' };
    }

    const decoder = new TextDecoder();
    const { value } = await reader.read();
    reader.cancel();

    if (value) {
      const text = decoder.decode(value);
      if (text.includes('"connected"') || text.includes('heartbeat')) {
        return { success: true };
      }
    }

    return { success: false, error: 'Unexpected response from SSE' };

  } catch (error) {
    clearTimeout(timeout);
    if (error instanceof Error && error.name === 'AbortError') {
      return { success: false, error: 'Connection timed out' };
    }
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
}
