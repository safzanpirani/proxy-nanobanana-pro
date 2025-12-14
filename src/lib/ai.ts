import { GoogleGenAI, type Chat, type Content, type Part, Modality } from '@google/genai';

export const MODEL_ID = 'gemini-3-pro-image-preview';

export const client = new GoogleGenAI({
  apiKey: 'dummy-key',
  httpOptions: {
    baseUrl: 'http://localhost:8317',
  },
});

export const ASPECT_RATIOS = [
  { value: '1:1', label: '1:1', icon: '■' },
  { value: '16:9', label: '16:9', icon: '▬' },
  { value: '9:16', label: '9:16', icon: '▮' },
  { value: '4:3', label: '4:3', icon: '▭' },
  { value: '3:4', label: '3:4', icon: '▯' },
  { value: '21:9', label: '21:9', icon: '━' },
  { value: '2:3', label: '2:3', icon: '▯' },
  { value: '3:2', label: '3:2', icon: '▭' },
  { value: '4:5', label: '4:5', icon: '▯' },
  { value: '5:4', label: '5:4', icon: '▭' },
] as const;

export type AspectRatio = typeof ASPECT_RATIOS[number]['value'];

export const RESOLUTIONS = [
  { value: '1K', label: '1K', desc: '1024px' },
  { value: '2K', label: '2K', desc: '2048px' },
  { value: '4K', label: '4K', desc: '4096px' },
] as const;

export type Resolution = typeof RESOLUTIONS[number]['value'];

export interface ThoughtPart {
  type: 'thought-text' | 'thought-image';
  text?: string;
  imageData?: string;
  mimeType?: string;
  storageId?: string | null;
}

export interface OutputPart {
  type: 'text' | 'image';
  text?: string;
  imageData?: string;
  mimeType?: string;
  signature?: string;
  storageId?: string | null;
}

export interface ParsedResponse {
  thoughts: ThoughtPart[];
  outputs: OutputPart[];
  finishReason?: string;
}

export interface UploadedImage {
  id: string;
  dataUrl: string;
  mimeType: string;
  name: string;
  storageId?: string | null;
}

export function parseResponseParts(parts: Part[]): ParsedResponse {
  const thoughts: ThoughtPart[] = [];
  const outputs: OutputPart[] = [];

  for (const part of parts) {
    const rawPart = part as Record<string, unknown>;
    const isThought = rawPart.thought === true;
    
    if (part.text) {
      if (isThought) {
        thoughts.push({ type: 'thought-text', text: part.text });
      } else {
        outputs.push({
          type: 'text',
          text: part.text,
          signature: (rawPart.thoughtSignature || rawPart.thought_signature) as string | undefined,
        });
      }
    } else if (part.inlineData) {
      const mimeType = part.inlineData.mimeType || 'image/png';
      const data = part.inlineData.data;
      
      if (isThought) {
        thoughts.push({
          type: 'thought-image',
          imageData: `data:${mimeType};base64,${data}`,
          mimeType,
        });
      } else {
        outputs.push({
          type: 'image',
          imageData: `data:${mimeType};base64,${data}`,
          mimeType,
          signature: (rawPart.thoughtSignature || rawPart.thought_signature) as string | undefined,
        });
      }
    }
  }

  return { thoughts, outputs };
}

export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      const base64 = result.split(',')[1];
      resolve(base64);
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

export function createImagePart(base64: string, mimeType: string): Part {
  return {
    inlineData: {
      data: base64,
      mimeType,
    },
  };
}

export { Modality };
export type { Chat, Content, Part };
