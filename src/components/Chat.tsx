import { useState, useRef, useEffect, type FormEvent, type ChangeEvent, type ClipboardEvent } from 'react';
import { client, MODEL_ID, ASPECT_RATIOS, RESOLUTIONS, createImagePart, Modality, type AspectRatio, type Resolution, type ThoughtPart, type OutputPart, type Content, type UploadedImage, type Part } from '../lib/ai';
import * as storage from '../lib/storage';
import { FlowithConfig, loadFlowithConfig, saveFlowithConfig } from './FlowithConfig';
import {
  type FlowithConfig as FlowithConfigType,
  type FlowithAspectRatio,
  type FlowithImageSize,
  type FlowithMessage,
  type FlowithErrorType,
  uploadImageFromDataUrl,
  generateImage as flowithGenerateImage,
  generateBatch as flowithGenerateBatch,
  validateConfig as validateFlowithConfig,
  getFlowithErrorMessage,
} from '../lib/flowith';

type GenerationMode = 'local' | 'flowith';

interface FlowithReplyContext {
  imageUrl: string;
  imageDataUrl: string;
  history: FlowithMessage[];
}

interface LocalReplyContext {
  imageDataUrl: string;
  turnIdx: number;
  history: Content[];
}

interface GenerationState {
  thoughts: ThoughtPart[];
  outputs: OutputPart[];
  isGenerating: boolean;
  phase: 'idle' | 'thinking' | 'generating' | 'done';
  error?: string;
  errorType?: FlowithErrorType;
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

async function fetchImageAsDataUrl(imageUrl: string): Promise<string> {
  const response = await fetch(imageUrl);
  const blob = await response.blob();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
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
  const [bulkCount, setBulkCount] = useState<1 | 2 | 4 | 8>(1);
  const [conversation, setConversation] = useState<ConversationTurn[]>([]);
  const [conversationHistory, setConversationHistory] = useState<Content[]>([]);
  const [current, setCurrent] = useState<GenerationState>({
    thoughts: [],
    outputs: [],
    isGenerating: false,
    phase: 'idle',
  });
  
  // Bulk generation state
  const [bulkResults, setBulkResults] = useState<Array<{
    id: string;
    status: 'pending' | 'generating' | 'done' | 'error';
    outputs: OutputPart[];
    thoughts: ThoughtPart[];
    error?: string;
    errorType?: FlowithErrorType;
    generationTime?: number;
  }>>([]);
  
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
  
  // Warning for legacy sessions without signature support
  const [legacySessionWarning, setLegacySessionWarning] = useState(false);
  
  // Live generation timer
  const [elapsedTime, setElapsedTime] = useState(0);
  
  const [generationMode, setGenerationMode] = useState<GenerationMode>(() => {
    const saved = localStorage.getItem('generationMode');
    return (saved === 'flowith' ? 'flowith' : 'local') as GenerationMode;
  });
  
  const [flowithConfig, setFlowithConfig] = useState<FlowithConfigType>(() => loadFlowithConfig());
  
  const [flowithProgress, setFlowithProgress] = useState<'idle' | 'uploading' | 'connected' | 'processing'>('idle');
  
  const [flowithReplyContext, setFlowithReplyContext] = useState<FlowithReplyContext | null>(null);
  
  const [flowithConversationHistory, setFlowithConversationHistory] = useState<FlowithMessage[]>([]);
  
  const [localReplyContext, setLocalReplyContext] = useState<LocalReplyContext | null>(null);
  
  // Default prompt presets
  const DEFAULT_PRESETS: Array<{ name: string; prompt: string }> = [
    // Master Template
    { name: "📱 iPhone Reality Master", prompt: "IMG_9824.HEIC, candid iPhone 15 Pro photo of [Subject from Image 1] [doing activity/in location], taken with flash, raw style, skin texture, natural skin oils, imperfect framing, motion blur, social media compression, hard lighting, authentic look, 4k." },
    // Dating - Men
    { name: "💘 Sunday Coffee (M)", prompt: "Candid iPhone photo of the man from image 1 sitting at an outdoor cafe table, holding a latte, laughing naturally at someone off-camera. Morning sunlight, portrait mode, blurred street background. He is wearing a fitted grey t-shirt. High-key lighting, genuine smile, authentic skin texture." },
    { name: "💘 Hobbyist Chef (M)", prompt: "Waist-up iPhone shot of the man from image 1 in a modern kitchen, chopping vegetables on a wooden board. He is looking up and smiling. Warm indoor lighting, messy countertop with ingredients. He is wearing a casual button-down with sleeves rolled up. Slight motion blur on the hands, cozy vibe." },
    { name: "💘 Hiking (M)", prompt: "Full-body wide shot of the man from image 1 standing on a rocky trail with a mountain view behind. Mid-day harsh sunlight, deep shadows, wearing athletic gear and sunglasses. He is looking away towards the horizon. GoPro style wide angle, vivid colors, realistic sweat sheen on skin." },
    { name: "💘 Dog Dad (M)", prompt: "Close-up selfie taken by the man from image 1 lying on a couch with a golden retriever resting its head on his chest. Indoor soft lighting, grainy texture, cozy atmosphere. The man is smiling softly at the camera. focus on the dog's fur and the man's facial features." },
    { name: "💘 Formal Event (M)", prompt: "Mirror selfie of the man from image 1 in a well-lit elevator, wearing a sharp navy blue suit and unbuttoned white collar. Metallic elevator textures, overhead fluorescent lighting causing realistic shadows on the face. Confident posture, holding the phone at chest level." },
    { name: "💘 Bar Candid (M)", prompt: "Slightly blurry, low-light iPhone photo of the man from image 1 holding a cocktail in a dim speakeasy. Neon sign reflecting on his face, red and blue ambient light. He is mid-conversation, looking to the side. Flash photography style, 'night out' aesthetic, red-eye reduction look." },
    // Dating - Women
    { name: "💖 Golden Hour (F)", prompt: "Selfie of the woman from image 1 taken during sunset, warm orange light hitting her face directly. Lens flare, wind blowing hair across her face slightly. She is wearing a sundress. detailed skin pores, no makeup look, 'sun-kissed' filter aesthetic, horizon line slightly crooked." },
    { name: "💖 Brunch Date (F)", prompt: "Across-the-table iPhone shot of the woman from image 1 holding a mimosa, sitting in a trendy restaurant with plants in the background. Natural window lighting from the side. She is laughing with eyes slightly closed. High definition, bright colors, plate of food in the foreground out of focus." },
    { name: "💖 Gym Mirror (F)", prompt: "Full body mirror selfie of the woman from image 1 in a gym locker room. Fluorescent overhead lights, wearing matching workout set. She is holding the phone covering half her face. Realistic gym background with lockers, slight digital noise, sharp focus on the outfit and posture." },
    { name: "💖 Museum (F)", prompt: "Candid shot of the woman from image 1 standing in front of a large painting in an art gallery. She is looking back over her shoulder at the camera. Soft, museum spot lighting, quiet atmosphere. She is wearing a stylish trench coat. Minimalist composition, high contrast." },
    { name: "💖 Cozy Home (F)", prompt: "High-angle selfie of the woman from image 1 sitting on a bed with a messy bun, wearing an oversized sweater and knee-high socks. Reading a book, looking up at the camera. Soft morning light, grainy 'film' simulation, messy bedroom background (pillows, blankets)." },
    { name: "💖 Night Out (F)", prompt: "Flash photo of the woman from image 1 standing against a brick wall at night. Hard flash lighting, high contrast, wearing a black evening dress. 'Paparazzi' style, red lipstick, sharp shadows behind her, vignette effect." },
    // Unisex Reality
    { name: "📸 Car Selfie", prompt: "Selfie of the person from image 1 sitting in the driver's seat of a car. Seatbelt on. Overcast weather outside, soft diffused lighting coming through the window. Raindrops on the window glass. Focus on eyes, realistic skin texture, pore visibility, slightly desaturated colors." },
    { name: "📸 Grocery Store", prompt: "Waist-up shot of the person from image 1 in a grocery store aisle, holding a box of cereal. Harsh fluorescent aisle lighting, colorful products in background. The person is making a funny face. 4k, raw photo, depth of field, bright colors." },
    { name: "📸 Office Desk", prompt: "Webcam-style angle or front-facing camera shot of the person from image 1 sitting at an office desk. Computer monitor glow reflecting blue light on their face. Coffee mug in hand. Background includes a whiteboard and office chair. 'Work from home' vibe, slightly grainy." },
    { name: "📸 Elevator Mirror", prompt: "Full body mirror shot in a corporate elevator. The person from image 1 is looking at the phone screen, not the mirror. Stainless steel reflections, overhead LED lights. wearing casual street style. 'OOTD' (Outfit of the Day) aesthetic, sharp details on shoes and denim texture." },
    // Beach & Swimwear
    { name: "🏖️ Tanning POV (F)", prompt: "IMG_4021.HEIC, high-angle selfie of the woman from image 1 lying on a striped beach towel. She is wearing a colorful triangle bikini. Harsh noon sunlight creating deep shadows under the neck. Sunglasses perched on top of head. Skin looks glistening with tanning oil, visible sand grains on the towel, ocean waves visible in the top corner. 4k, sharp focus." },
    { name: "🏖️ Golden Hour Dip (F)", prompt: "Waist-up shot of the woman from image 1 standing in the ocean at sunset. She is wearing a black swimsuit. The sun is behind her, creating a silhouette effect with hair glowing gold (rim light). She is looking back at the camera, wet hair slicked back. Water droplets on skin, lens flare, soft focus background." },
    { name: "🏖️ Poolside Lounge (F)", prompt: "Candid photo of the woman from image 1 sitting on a white lounge chair, wearing a bright neon bikini. She is holding a cold drink with condensation. Bright blue pool water background. Skin texture is highly detailed. Shot on iPhone 15 Pro, vivid colors, 'vacation mode' aesthetic." },
    // Indoor & Lingerie
    { name: "🛌 Lazy Sunday (F)", prompt: "POV shot looking down at the woman from image 1 lying in unmade white bedsheets. She is wearing a soft lace bralette and lounge shorts. One arm is stretching up. Morning sunlight streaming through blinds, creating slat shadows across her torso and the bed. Messy hair, cozy atmosphere, slightly grainy low-light texture." },
    { name: "🛌 Bathroom Mirror (F)", prompt: "Mirror selfie of the woman from image 1 in a bathroom. She is wearing a matching Calvin Klein underwear set. The mirror has slight smudges/water spots (adding realism). Flash is ON, creating a bright reflection. Background shows a counter with makeup and toiletries. Authentic skin texture, no smoothing filter." },
    { name: "🛌 Night Slip (F)", prompt: "Disposable camera style photo of the woman from image 1 sitting on the edge of a bed at night. She is wearing a silk slip dress. Direct flash photography, dark background, high contrast shadows. Red-eye reduction look, slightly desaturated colors, 'cool girl' aesthetic." },
    { name: "🛌 Getting Ready (F)", prompt: "Side profile shot of the woman from image 1 standing near a window, putting on earrings. She is wearing a silk robe that is slightly open showing a hint of lace underneath. Soft overcast window lighting, very natural skin tones. Background is a slightly blurry bedroom interior." },
  ];

  // Prompt presets with name and prompt
  const [promptPresets, setPromptPresets] = useState<Array<{ name: string; prompt: string }>>(() => {
    const saved = localStorage.getItem('promptPresetsV2');
    if (saved) {
      return JSON.parse(saved);
    }
    // Return defaults if nothing saved
    return DEFAULT_PRESETS;
  });
  const [showPresetInput, setShowPresetInput] = useState(false);
  const [newPresetName, setNewPresetName] = useState('');
  const [newPresetText, setNewPresetText] = useState('');
  const [presetSearch, setPresetSearch] = useState('');

  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const outputRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    storage.getAllSessionsMeta().then(setSessions);
  }, []);

  // Live timer effect
  useEffect(() => {
    let interval: ReturnType<typeof setInterval>;
    if (current.isGenerating && current.startTime) {
      interval = setInterval(() => {
        setElapsedTime(Date.now() - current.startTime!);
      }, 100);
    } else {
      setElapsedTime(0);
    }
    return () => clearInterval(interval);
  }, [current.isGenerating, current.startTime]);

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

  useEffect(() => {
    localStorage.setItem('generationMode', generationMode);
  }, [generationMode]);

  useEffect(() => {
    saveFlowithConfig(flowithConfig);
  }, [flowithConfig]);

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

      // Use localReplyContext history if set, otherwise use regular conversationHistory
      const historyToUse = localReplyContext ? localReplyContext.history : conversationHistory;
      const contents: Content[] = useCurrentHistory 
        ? [...historyToUse, { role: 'user', parts: userParts }]
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

      setConversationHistory([
        ...historyToUse, 
        { role: 'user', parts: userParts }, 
        { role: 'model', parts: modelParts }
      ]);

      // Clear local reply context after successful generation
      if (localReplyContext) {
        setLocalReplyContext(null);
      }

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      setCurrent(prev => ({ ...prev, isGenerating: false, phase: 'done', error: errorMessage }));
    }
  }

  // Single request for bulk generation (doesn't update conversation, just returns result)
  async function generateSingleRequest(
    prompt: string,
    images: UploadedImage[],
    requestId: string,
    effectiveAspectRatio: AspectRatio,
    effectiveResolution: Resolution
  ): Promise<{
    id: string;
    outputs: OutputPart[];
    thoughts: ThoughtPart[];
    error?: string;
    generationTime: number;
  }> {
    const startTime = Date.now();
    
    try {
      const userParts: Part[] = [];
      if (prompt) userParts.push({ text: prompt });
      for (const img of images) {
        const base64 = img.dataUrl.split(',')[1];
        userParts.push(createImagePart(base64, img.mimeType));
      }

      const contents: Content[] = [...conversationHistory, { role: 'user', parts: userParts }];

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

      return {
        id: requestId,
        outputs: collectedOutputs,
        thoughts: collectedThoughts,
        generationTime: Date.now() - startTime,
      };
    } catch (error) {
      return {
        id: requestId,
        outputs: [],
        thoughts: [],
        error: error instanceof Error ? error.message : 'Unknown error',
        generationTime: Date.now() - startTime,
      };
    }
  }

  // Bulk generation - fires multiple parallel requests
  async function generateBulk(prompt: string, images: UploadedImage[]) {
    if (current.isGenerating) return;

    const startTime = Date.now();

    if (!currentSessionId) {
      setCurrentSessionId(`${Date.now()}`);
    }

    // Add user turn to conversation
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

    // Initialize bulk results
    const initialResults = Array.from({ length: bulkCount }, (_, i) => ({
      id: `bulk-${Date.now()}-${i}`,
      status: 'pending' as const,
      outputs: [] as OutputPart[],
      thoughts: [] as ThoughtPart[],
    }));
    setBulkResults(initialResults);

    // Fire all requests in parallel
    const promises = initialResults.map(async (result) => {
      // Update status to generating
      setBulkResults(prev => prev.map(r => 
        r.id === result.id ? { ...r, status: 'generating' as const } : r
      ));

      const response = await generateSingleRequest(
        prompt,
        images,
        result.id,
        aspectRatio,
        resolution
      );

      // Update with result
      setBulkResults(prev => prev.map(r => 
        r.id === result.id ? {
          ...r,
          status: response.error ? 'error' as const : 'done' as const,
          outputs: response.outputs,
          thoughts: response.thoughts,
          error: response.error,
          generationTime: response.generationTime,
        } : r
      ));

      return response;
    });

    // Wait for all to complete
    const results = await Promise.all(promises);
    
    // Use the first successful result for the conversation
    const firstSuccess = results.find(r => !r.error && r.outputs.length > 0);
    
    if (firstSuccess) {
      const endTime = Date.now();
      
      // Collect ALL outputs from ALL successful results
      const allOutputs = results
        .filter(r => !r.error)
        .flatMap(r => r.outputs);
      
      const allThoughts = results
        .filter(r => !r.error)
        .flatMap(r => r.thoughts);

      setConversation(prev => [...prev, {
        role: 'model',
        thoughts: allThoughts,
        outputs: allOutputs,
        aspectRatio,
        resolution,
        timestamp: new Date(),
        generationTime: endTime - startTime,
      }]);

      // Build history from first successful result (for multi-turn)
      const userParts: Part[] = [];
      if (prompt) userParts.push({ text: prompt });
      for (const img of images) {
        const base64 = img.dataUrl.split(',')[1];
        userParts.push(createImagePart(base64, img.mimeType));
      }

      const modelParts: Part[] = [];
      for (const output of firstSuccess.outputs) {
        if (output.type === 'text' && output.text) {
          const textPart: Record<string, unknown> = { text: output.text };
          if (output.signature) textPart.thoughtSignature = output.signature;
          modelParts.push(textPart as Part);
        } else if (output.type === 'image' && output.imageData) {
          const base64 = output.imageData.split(',')[1];
          const imagePart: Record<string, unknown> = {
            inlineData: { mimeType: output.mimeType || 'image/png', data: base64 }
          };
          if (output.signature) imagePart.thoughtSignature = output.signature;
          modelParts.push(imagePart as Part);
        }
      }

      setConversationHistory(prev => [
        ...prev,
        { role: 'user', parts: userParts },
        { role: 'model', parts: modelParts }
      ]);
    }

    setCurrent({
      thoughts: [],
      outputs: [],
      isGenerating: false,
      phase: 'done',
      startTime,
      endTime: Date.now(),
    });

    // Clear bulk results after a delay
    setTimeout(() => setBulkResults([]), 500);
  }

  function mapResolutionToFlowith(res: Resolution): FlowithImageSize {
    return res.toLowerCase() as FlowithImageSize;
  }

  function mapAspectRatioToFlowith(ratio: AspectRatio): FlowithAspectRatio {
    return ratio as FlowithAspectRatio;
  }

  async function generateWithFlowith(
    prompt: string,
    images: UploadedImage[]
  ) {
    if (current.isGenerating) return;

    const validation = validateFlowithConfig(flowithConfig);
    if (!validation.valid) {
      setCurrent(prev => ({ ...prev, error: validation.error }));
      return;
    }

    const startTime = Date.now();

    if (!currentSessionId) {
      setCurrentSessionId(`${Date.now()}`);
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
    setFlowithProgress('uploading');

    try {
      const uploadedFlowithImages: Array<{ url: string; filename: string }> = [];
      const imagesWithFlowithUrls: UploadedImage[] = [];
      
      for (const img of images) {
        if (img.dataUrl) {
          const url = await uploadImageFromDataUrl(
            img.dataUrl,
            img.name || `image-${img.id}.png`,
            flowithConfig.token
          );
          uploadedFlowithImages.push({ url, filename: img.name || `image-${img.id}.png` });
          imagesWithFlowithUrls.push({ ...img, flowithFileUrl: url });
        } else {
          imagesWithFlowithUrls.push(img);
        }
      }

      // Update the user turn with Flowith file URLs for reply context reconstruction
      if (imagesWithFlowithUrls.length > 0) {
        setConversation(prev => {
          const newConv = [...prev];
          const lastIdx = newConv.length - 1;
          if (lastIdx >= 0 && newConv[lastIdx].role === 'user') {
            newConv[lastIdx] = { ...newConv[lastIdx], images: imagesWithFlowithUrls };
          }
          return newConv;
        });
      }

      setFlowithProgress('processing');

      const historyToUse = flowithReplyContext ? flowithReplyContext.history : flowithConversationHistory;

      const result = await flowithGenerateImage(
        flowithConfig,
        {
          prompt,
          aspectRatio: mapAspectRatioToFlowith(aspectRatio),
          imageSize: mapResolutionToFlowith(resolution),
          images: uploadedFlowithImages.length > 0 ? uploadedFlowithImages : undefined,
          conversationHistory: historyToUse.length > 0 ? historyToUse : undefined,
        },
        (event) => {
          if (event === 'connected') setFlowithProgress('connected');
          if (event === 'processing') setFlowithProgress('processing');
        }
      );

      const endTime = Date.now();

      if (result.status === 'completed' && result.imageUrl) {
        const imageDataUrl = await fetchImageAsDataUrl(result.imageUrl);
        
        const collectedOutputs: OutputPart[] = [{
          type: 'image',
          imageData: imageDataUrl,
          mimeType: 'image/jpeg',
          flowithUrl: result.imageUrl,
        }];
        setCurrent({
          thoughts: [],
          outputs: collectedOutputs,
          isGenerating: false,
          phase: 'done',
          startTime,
          endTime,
        });

        setConversation(prev => [...prev, {
          role: 'model',
          thoughts: [],
          outputs: collectedOutputs,
          aspectRatio,
          resolution,
          timestamp: new Date(),
          generationTime: endTime - startTime,
        }]);

        const userMessageContent = uploadedFlowithImages.length > 0
          ? `${prompt}\n\n${uploadedFlowithImages.map(img => `![${img.filename}](${img.url})`).join('\n')}`
          : prompt;

        setFlowithConversationHistory([
          ...historyToUse,
          { content: userMessageContent, role: 'user' as const },
          { content: result.imageUrl!, role: 'assistant' as const },
        ]);

        setFlowithReplyContext(null);
      } else {
        const errorMsg = getFlowithErrorMessage(result.errorType, result.error);
        setCurrent(prev => ({ 
          ...prev, 
          isGenerating: false, 
          phase: 'done', 
          error: errorMsg,
          errorType: result.errorType,
        }));
      }

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      setCurrent(prev => ({ ...prev, isGenerating: false, phase: 'done', error: errorMessage }));
    } finally {
      setFlowithProgress('idle');
    }
  }

  async function generateBulkWithFlowith(prompt: string, images: UploadedImage[]) {
    if (current.isGenerating) return;

    const validation = validateFlowithConfig(flowithConfig);
    if (!validation.valid) {
      setCurrent(prev => ({ ...prev, error: validation.error }));
      return;
    }

    const startTime = Date.now();

    if (!currentSessionId) {
      setCurrentSessionId(`${Date.now()}`);
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
    setFlowithProgress('uploading');

    const initialResults = Array.from({ length: bulkCount }, (_, i) => ({
      id: `bulk-${Date.now()}-${i}`,
      status: 'pending' as const,
      outputs: [] as OutputPart[],
      thoughts: [] as ThoughtPart[],
    }));
    setBulkResults(initialResults);

    try {
      const uploadedFlowithImages: Array<{ url: string; filename: string }> = [];
      const imagesWithFlowithUrls: UploadedImage[] = [];
      
      for (const img of images) {
        if (img.dataUrl) {
          const url = await uploadImageFromDataUrl(
            img.dataUrl,
            img.name || `image-${img.id}.png`,
            flowithConfig.token
          );
          uploadedFlowithImages.push({ url, filename: img.name || `image-${img.id}.png` });
          imagesWithFlowithUrls.push({ ...img, flowithFileUrl: url });
        } else {
          imagesWithFlowithUrls.push(img);
        }
      }

      if (imagesWithFlowithUrls.length > 0) {
        setConversation(prev => {
          const newConv = [...prev];
          const lastIdx = newConv.length - 1;
          if (lastIdx >= 0 && newConv[lastIdx].role === 'user') {
            newConv[lastIdx] = { ...newConv[lastIdx], images: imagesWithFlowithUrls };
          }
          return newConv;
        });
      }

      setFlowithProgress('processing');

      const results = await flowithGenerateBatch(
        flowithConfig,
        {
          prompt,
          aspectRatio: mapAspectRatioToFlowith(aspectRatio),
          imageSize: mapResolutionToFlowith(resolution),
          images: uploadedFlowithImages.length > 0 ? uploadedFlowithImages : undefined,
        },
        bulkCount,
        async (index, event, result) => {
          if (event === 'started') {
            setBulkResults(prev => prev.map((r, i) => 
              i === index ? { ...r, status: 'generating' as const } : r
            ));
          } else if (event === 'completed' && result?.imageUrl) {
            try {
              const imageDataUrl = await fetchImageAsDataUrl(result.imageUrl);
              setBulkResults(prev => prev.map((r, i) => 
                i === index ? {
                  ...r,
                  status: 'done' as const,
                  outputs: [{ type: 'image' as const, imageData: imageDataUrl, mimeType: 'image/jpeg' }],
                  generationTime: result.generationTime,
                } : r
              ));
            } catch {
              setBulkResults(prev => prev.map((r, i) => 
                i === index ? { ...r, status: 'error' as const, error: 'Failed to fetch image' } : r
              ));
            }
          } else if (event === 'error') {
            const errorMsg = getFlowithErrorMessage(result?.errorType, result?.error);
            setBulkResults(prev => prev.map((r, i) => 
              i === index ? { ...r, status: 'error' as const, error: errorMsg, errorType: result?.errorType } : r
            ));
          }
        }
      );

      const endTime = Date.now();

      const allOutputs: OutputPart[] = [];
      for (const r of results) {
        if (r.status === 'completed' && r.imageUrl) {
          try {
            const imageDataUrl = await fetchImageAsDataUrl(r.imageUrl);
            allOutputs.push({
              type: 'image' as const,
              imageData: imageDataUrl,
              mimeType: 'image/jpeg',
            });
          } catch (e) {
            console.error('Failed to fetch image:', r.imageUrl, e);
          }
        }
      }

      if (allOutputs.length > 0) {
        setConversation(prev => [...prev, {
          role: 'model',
          thoughts: [],
          outputs: allOutputs,
          aspectRatio,
          resolution,
          timestamp: new Date(),
          generationTime: endTime - startTime,
        }]);
      }

      setCurrent({
        thoughts: [],
        outputs: [],
        isGenerating: false,
        phase: 'done',
        startTime,
        endTime,
      });

      setTimeout(() => setBulkResults([]), 500);

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      setCurrent(prev => ({ ...prev, isGenerating: false, phase: 'done', error: errorMessage }));
    } finally {
      setFlowithProgress('idle');
    }
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if ((!input.trim() && uploadedImages.length === 0) || current.isGenerating) return;

    const prompt = input.trim();
    const images = [...uploadedImages];
    setInput('');
    setUploadedImages([]);
    
    if (generationMode === 'flowith') {
      if (bulkCount > 1) {
        await generateBulkWithFlowith(prompt, images);
      } else {
        await generateWithFlowith(prompt, images);
      }
    } else {
      if (bulkCount > 1) {
        await generateBulk(prompt, images);
      } else {
        await generateWithParams(prompt, images, true);
      }
    }
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
      
      if (generationMode === 'flowith') {
        if (bulkCount > 1) {
          await generateBulkWithFlowith(prompt, images);
        } else {
          await generateWithFlowith(prompt, images);
        }
      } else {
        if (bulkCount > 1) {
          await generateBulk(prompt, images);
        } else {
          await generateWithParams(prompt, images, true);
        }
      }
      return;
    }
    
    // Default behavior: regenerate last turn
    if (!lastPrompt && lastImages.length === 0) return;
    
    if (conversation.length >= 2 && conversation[conversation.length - 1].role === 'model') {
      setConversation(prev => prev.slice(0, -2));
      setConversationHistory(prev => prev.slice(0, -2));
    }
    
    if (generationMode === 'flowith') {
      if (bulkCount > 1) {
        await generateBulkWithFlowith(lastPrompt, lastImages);
      } else {
        await generateWithFlowith(lastPrompt, lastImages);
      }
    } else {
      if (bulkCount > 1) {
        await generateBulk(lastPrompt, lastImages);
      } else {
        await generateWithParams(lastPrompt, lastImages, true);
      }
    }
  }

  async function handleRegenerateFromUserTurn(userTurnIdx: number) {
    if (current.isGenerating) return;
    
    const userTurn = conversation[userTurnIdx];
    if (!userTurn || userTurn.role !== 'user') return;
    
    const prompt = userTurn.prompt || '';
    const images = userTurn.images || [];
    
    // Remove this turn and all turns after it
    setConversation(prev => prev.slice(0, userTurnIdx));
    setConversationHistory(prev => {
      const turnsToKeep = userTurnIdx;
      const historyEntriesToKeep = Math.floor(turnsToKeep / 2) * 2;
      return prev.slice(0, historyEntriesToKeep);
    });
    
    if (generationMode === 'flowith') {
      if (bulkCount > 1) {
        await generateBulkWithFlowith(prompt, images);
      } else {
        await generateWithFlowith(prompt, images);
      }
    } else {
      if (bulkCount > 1) {
        await generateBulk(prompt, images);
      } else {
        await generateWithParams(prompt, images, true);
      }
    }
  }

  function handleNewSession() {
    setConversation([]);
    setConversationHistory([]);
    setUploadedImages([]);
    setCurrentSessionId(null);
    setLastPrompt('');
    setLastImages([]);
    setLegacySessionWarning(false);
    setCurrent({
      thoughts: [],
      outputs: [],
      isGenerating: false,
      phase: 'idle',
    });
    setFlowithConversationHistory([]);
    setFlowithReplyContext(null);
    setLocalReplyContext(null);
  }

  function handleSelectFlowithReply(output: OutputPart, _userPrompt: string, turnIdx: number) {
    if (!output.flowithUrl || !output.imageData) return;

    if (flowithReplyContext?.imageUrl === output.flowithUrl) {
      setFlowithReplyContext(null);
      return;
    }

    const historyUpToThisPoint: FlowithMessage[] = [];
    for (let i = 0; i <= turnIdx; i++) {
      const turn = conversation[i];
      if (turn.role === 'user') {
        let userContent = turn.prompt || '';
        if (turn.images && turn.images.length > 0) {
          const imageMarkdown = turn.images
            .filter(img => img.flowithFileUrl)
            .map(img => `![${img.name}](${img.flowithFileUrl})`)
            .join('\n');
          if (imageMarkdown) {
            userContent = userContent ? `${userContent}\n\n${imageMarkdown}` : imageMarkdown;
          }
        }
        if (userContent) {
          historyUpToThisPoint.push({ content: userContent, role: 'user' });
        }
      } else if (turn.role === 'model') {
        const imageOutput = turn.outputs.find(o => o.type === 'image' && o.flowithUrl);
        if (imageOutput?.flowithUrl) {
          historyUpToThisPoint.push({ content: imageOutput.flowithUrl, role: 'assistant' });
        }
      }
    }

    setFlowithReplyContext({
      imageUrl: output.flowithUrl,
      imageDataUrl: output.imageData,
      history: historyUpToThisPoint,
    });

    textareaRef.current?.focus();
  }

  function handleClearFlowithReply() {
    setFlowithReplyContext(null);
  }

  async function handleSelectLocalReply(output: OutputPart, turnIdx: number) {
    if (!output.imageData) return;

    if (localReplyContext?.imageDataUrl === output.imageData) {
      setLocalReplyContext(null);
      return;
    }

    const historyUpToThisPoint: Content[] = [];
    for (let i = 0; i <= turnIdx; i++) {
      const turn = conversation[i];
      const parts: Part[] = [];
      
      if (turn.role === 'user') {
        if (turn.prompt) {
          parts.push({ text: turn.prompt });
        }
        if (turn.images) {
          for (const img of turn.images) {
            if (img.dataUrl) {
              let base64: string | undefined;
              
              if (img.dataUrl.startsWith('data:')) {
                base64 = img.dataUrl.split(',')[1];
              } else {
                const dataUrl = await fetchImageAsDataUrl(img.dataUrl);
                base64 = dataUrl.split(',')[1];
              }
              
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
        }
      } else if (turn.role === 'model') {
        for (const out of turn.outputs) {
          if (out.type === 'text' && out.text) {
            const textPart: Record<string, unknown> = { text: out.text };
            if (out.signature) {
              textPart.thoughtSignature = out.signature;
            }
            parts.push(textPart as Part);
          } else if (out.type === 'image' && out.imageData) {
            let base64: string | undefined;
            
            if (out.imageData.startsWith('data:')) {
              base64 = out.imageData.split(',')[1];
            } else {
              const dataUrl = await fetchImageAsDataUrl(out.imageData);
              base64 = dataUrl.split(',')[1];
            }
            
            if (base64) {
              const imagePart: Record<string, unknown> = {
                inlineData: {
                  mimeType: out.mimeType || 'image/png',
                  data: base64,
                }
              };
              if (out.signature) {
                imagePart.thoughtSignature = out.signature;
              }
              parts.push(imagePart as Part);
            }
          }
        }
      }
      
      if (parts.length > 0) {
        historyUpToThisPoint.push({ role: turn.role, parts });
      }
    }

    setLocalReplyContext({
      imageDataUrl: output.imageData,
      turnIdx,
      history: historyUpToThisPoint,
    });

    textareaRef.current?.focus();
  }

  function handleClearLocalReply() {
    setLocalReplyContext(null);
  }

  // Prompt preset management
  function addPreset(name: string, prompt: string) {
    if (!name.trim() || !prompt.trim()) return;
    const updated = [...promptPresets, { name: name.trim(), prompt: prompt.trim() }];
    setPromptPresets(updated);
    localStorage.setItem('promptPresetsV2', JSON.stringify(updated));
    setNewPresetName('');
    setNewPresetText('');
    setShowPresetInput(false);
  }

  function removePreset(index: number) {
    const updated = promptPresets.filter((_, i) => i !== index);
    setPromptPresets(updated);
    localStorage.setItem('promptPresetsV2', JSON.stringify(updated));
  }

  function resetPresetsToDefault() {
    setPromptPresets(DEFAULT_PRESETS);
    localStorage.setItem('promptPresetsV2', JSON.stringify(DEFAULT_PRESETS));
  }

  function usePreset(text: string) {
    setInput(text);
    textareaRef.current?.focus();
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
      
      // Check if this session has model images without signatures (legacy session)
      const hasImagesWithoutSignature = data.some(turn => 
        turn.role === 'model' && 
        turn.outputs.some(o => o.type === 'image' && o.imageData && !o.signature)
      );
      setLegacySessionWarning(hasImagesWithoutSignature);
      
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
  
  function handleCancelEdit() {
    setEditingTurnIdx(null);
    setEditInput('');
    setEditImages([]);
  }
  
  function handleCopyPrompt(prompt: string) {
    navigator.clipboard.writeText(prompt);
  }
  
  // Save edit and regenerate (creates a new branch/version)
  async function handleSaveEdit() {
    if (editingTurnIdx === null || current.isGenerating) return;
    
    const userTurnIdx = editingTurnIdx;
    const modelTurnIdx = userTurnIdx + 1;
    const userTurn = conversation[userTurnIdx];
    const modelTurn = conversation[modelTurnIdx];
    
    if (!userTurn || userTurn.role !== 'user') return;
    
    // Preserve original parameters for version history
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
    const versions = existingVersions.length === 0 
      ? [currentVersion] 
      : existingVersions;
    
    const newPrompt = editInput.trim();
    const newImages = [...editImages];
    
    // Truncate conversation BEFORE the edited turn
    const truncatedConversation = conversation.slice(0, userTurnIdx);
    
    const versionsToPreserve = versions;
    
    setConversation(truncatedConversation);
    
    await rebuildConversationHistory(truncatedConversation);
    
    setEditingTurnIdx(null);
    setEditInput('');
    setEditImages([]);
    
    if (generationMode === 'flowith') {
      if (bulkCount > 1) {
        await generateBulkWithFlowith(newPrompt, newImages);
      } else {
        await generateWithFlowith(newPrompt, newImages);
      }
    } else {
      if (bulkCount > 1) {
        await generateBulk(newPrompt, newImages);
      } else {
        await generateWithParams(newPrompt, newImages, true);
      }
    }
    
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
            if (img.dataUrl) {
              let base64: string | undefined;
              
              if (img.dataUrl.startsWith('data:')) {
                base64 = img.dataUrl.split(',')[1];
              } else {
                const dataUrl = await fetchImageAsDataUrl(img.dataUrl);
                base64 = dataUrl.split(',')[1];
              }
              
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
            let base64: string | undefined;
            
            if (output.imageData.startsWith('data:')) {
              base64 = output.imageData.split(',')[1];
            } else {
              const dataUrl = await fetchImageAsDataUrl(output.imageData);
              base64 = dataUrl.split(',')[1];
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
  }

  const duration = current.startTime && current.endTime
    ? ((current.endTime - current.startTime) / 1000).toFixed(1)
    : null;

  const lastModelTurn = [...conversation].reverse().find(t => t.role === 'model');
  const canSubmit = (input.trim() || uploadedImages.length > 0) && !current.isGenerating;

  const filteredPresets = presetSearch.trim()
    ? promptPresets.filter(p => 
        p.name.toLowerCase().includes(presetSearch.toLowerCase()) ||
        p.prompt.toLowerCase().includes(presetSearch.toLowerCase())
      )
    : promptPresets;

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
              <label className="config-label">MODE</label>
              <div className="mode-switcher">
                <button
                  type="button"
                  className={`mode-btn ${generationMode === 'local' ? 'active' : ''}`}
                  onClick={() => setGenerationMode('local')}
                >
                  Local Proxy
                </button>
                <button
                  type="button"
                  className={`mode-btn ${generationMode === 'flowith' ? 'active' : ''}`}
                  onClick={() => setGenerationMode('flowith')}
                >
                  Flowith
                </button>
              </div>
            </div>

            {generationMode === 'local' && (
              <div className="config-section">
                <label className="config-label">MODEL</label>
                <div className="config-value config-mono">{MODEL_ID}</div>
              </div>
            )}

            {generationMode === 'flowith' && (
              <FlowithConfig 
                config={flowithConfig} 
                onConfigChange={setFlowithConfig} 
              />
            )}

            <div className="config-section">
              <label className="config-label">RESOLUTION</label>
              <div className="resolution-btns">
                {RESOLUTIONS.map(res => (
                  <button
                    key={res.value}
                    type="button"
                    onClick={() => setResolution(res.value)}
                    className={`res-btn ${resolution === res.value ? 'active' : ''}`}
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
                    title={ratio.label}
                  >
                    <span className="ratio-icon">{ratio.icon}</span>
                    <span className="ratio-label">{ratio.label}</span>
                  </button>
                ))}
              </div>
            </div>

            {generationMode === 'local' && (
              <div className="config-section">
                <label className="config-label">GROUNDING</label>
                <button
                  type="button"
                  onClick={() => setUseGrounding(!useGrounding)}
                  className={`toggle-btn ${useGrounding ? 'active' : ''}`}
                >
                  <span className="toggle-icon">{useGrounding ? '◉' : '○'}</span>
                  <span className="toggle-text">Google Search</span>
                </button>
              </div>
            )}

            <div className="config-section">
              <label className="config-label">BULK GENERATE</label>
              <div className="bulk-btns">
                {([1, 2, 4, 8] as const).map(count => (
                  <button
                    key={count}
                    type="button"
                    onClick={() => setBulkCount(count)}
                    className={`bulk-btn ${bulkCount === count ? 'active' : ''}`}
                  >
                    ×{count}
                  </button>
                ))}
              </div>
            </div>

            <div className="config-section">
              <label className="config-label">PROMPT PRESETS</label>
              <input
                type="text"
                className="preset-search"
                placeholder="Search presets..."
                value={presetSearch}
                onChange={(e) => setPresetSearch(e.target.value)}
              />
              <div className="presets-list">
                {filteredPresets.map((preset, idx) => (
                  <div key={idx} className="preset-item">
                    <button
                      type="button"
                      className="preset-btn"
                      onClick={() => usePreset(preset.prompt)}
                      title={preset.prompt}
                    >
                      {preset.name.length > 30 ? preset.name.slice(0, 30) + '...' : preset.name}
                    </button>
                    <button
                      type="button"
                      className="preset-delete"
                      onClick={() => removePreset(promptPresets.indexOf(preset))}
                    >
                      ×
                    </button>
                  </div>
                ))}
                {showPresetInput ? (
                  <div className="preset-input-row">
                    <input
                      type="text"
                      value={newPresetName}
                      onChange={(e) => setNewPresetName(e.target.value)}
                      placeholder="Preset name"
                      className="preset-input"
                    />
                    <input
                      type="text"
                      value={newPresetText}
                      onChange={(e) => setNewPresetText(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') addPreset(newPresetName, newPresetText);
                        if (e.key === 'Escape') setShowPresetInput(false);
                      }}
                      placeholder="Prompt text..."
                      className="preset-input preset-prompt-input"
                    />
                    <div className="preset-input-actions">
                      <button
                        type="button"
                        className="preset-save"
                        onClick={() => addPreset(newPresetName, newPresetText)}
                        disabled={!newPresetName.trim() || !newPresetText.trim()}
                      >
                        Save Preset
                      </button>
                      <button
                        type="button"
                        className="preset-cancel"
                        onClick={() => {
                          setShowPresetInput(false);
                          setNewPresetName('');
                          setNewPresetText('');
                        }}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <button
                    type="button"
                    className="add-preset-btn"
                    onClick={() => setShowPresetInput(true)}
                  >
                    + Add Preset
                  </button>
                )}
                {promptPresets.length > 0 && (
                  <button
                    type="button"
                    className="reset-presets-btn"
                    onClick={resetPresetsToDefault}
                  >
                    ↺ Reset to Defaults
                  </button>
                )}
              </div>
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
        {/* Top-right new session button */}
        <button 
          type="button"
          className="new-session-fab"
          onClick={handleNewSession}
          title="New Session"
        >
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <line x1="10" y1="4" x2="10" y2="16" />
            <line x1="4" y1="10" x2="16" y2="10" />
          </svg>
        </button>

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

          {/* Legacy session warning */}
          {legacySessionWarning && (
            <div className="legacy-warning">
              <span className="warning-icon">⚠</span>
              <span>This session was created before signature support. Multi-turn editing may not work. Consider starting a new session.</span>
              <button 
                type="button" 
                className="dismiss-warning"
                onClick={() => setLegacySessionWarning(false)}
              >
                ×
              </button>
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
                            className="msg-action-btn regen"
                            onClick={() => handleRegenerateFromUserTurn(idx)}
                            disabled={current.isGenerating}
                            title="Regenerate with current settings"
                          >
                            ↻
                          </button>
                          <button
                            type="button"
                            className="msg-action-btn copy"
                            onClick={() => handleCopyPrompt(turn.prompt || '')}
                            title="Copy prompt"
                          >
                            ⧉
                          </button>
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
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                            e.preventDefault();
                            if (editInput.trim() || editImages.length > 0) {
                              handleSaveEdit();
                            }
                          }
                          if (e.key === 'Escape') {
                            handleCancelEdit();
                          }
                        }}
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
                            <div 
                              key={imgIdx} 
                              className="user-image-thumb clickable"
                              onClick={() => img.dataUrl && setLightbox({
                                imageData: img.dataUrl,
                                prompt: `Input image: ${img.name}`,
                                resolution: turn.resolution,
                                aspectRatio: turn.aspectRatio,
                                timestamp: turn.timestamp,
                              })}
                            >
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
                                {generationMode === 'flowith' && output.flowithUrl && (
                                  <button
                                    type="button"
                                    className={`img-action-btn reply ${flowithReplyContext?.imageUrl === output.flowithUrl ? 'active' : ''}`}
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      handleSelectFlowithReply(output, prompt || '', idx);
                                    }}
                                    disabled={current.isGenerating}
                                    title="Reply to this image"
                                  >
                                    ↩ Reply
                                  </button>
                                )}
                                {generationMode === 'local' && output.imageData && (
                                  <button
                                    type="button"
                                    className={`img-action-btn reply ${localReplyContext?.imageDataUrl === output.imageData ? 'active' : ''}`}
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      handleSelectLocalReply(output, idx);
                                    }}
                                    disabled={current.isGenerating}
                                    title="Reply to this image"
                                  >
                                    ↩ Reply
                                  </button>
                                )}
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
              {bulkResults.length > 0 ? (
                <div className="bulk-progress">
                  <div className="bulk-progress-header">
                    <span className="pulse"></span>
                    GENERATING {bulkResults.filter(r => r.status === 'done').length}/{bulkResults.length}
                  </div>
                  <div className="bulk-progress-grid">
                    {bulkResults.map((result, idx) => (
                      <div 
                        key={result.id} 
                        className={`bulk-slot ${result.status} ${result.errorType ? `error-${result.errorType}` : ''}`}
                        title={result.error || undefined}
                      >
                        {result.status === 'pending' && <span className="slot-icon">◯</span>}
                        {result.status === 'generating' && <span className="slot-icon spinning">◐</span>}
                        {result.status === 'done' && result.outputs.find(o => o.type === 'image') ? (
                          <img 
                            src={result.outputs.find(o => o.type === 'image')?.imageData} 
                            alt={`Result ${idx + 1}`} 
                          />
                        ) : result.status === 'done' ? (
                          <span className="slot-icon">✓</span>
                        ) : null}
                        {result.status === 'error' && (
                          <div className="slot-error">
                            <span className="slot-icon error">
                              {result.errorType === 'content_policy' ? '🚫' : '✕'}
                            </span>
                            <span className="slot-error-type">
                              {result.errorType === 'content_policy' ? 'Blocked' : 'Failed'}
                            </span>
                          </div>
                        )}
                        <span className="slot-label">#{idx + 1}</span>
                      </div>
                    ))}
                  </div>
                  <div className="bulk-timer">{(elapsedTime / 1000).toFixed(1)}s</div>
                </div>
              ) : (
                <div className="streaming-badge large">
                  <span className="pulse"></span>
                  {generationMode === 'flowith' && flowithProgress !== 'idle' ? (
                    <>
                      {flowithProgress === 'uploading' && 'UPLOADING IMAGES...'}
                      {flowithProgress === 'connected' && 'CONNECTED...'}
                      {flowithProgress === 'processing' && 'GENERATING...'}
                    </>
                  ) : (
                    'GENERATING...'
                  )} {(elapsedTime / 1000).toFixed(1)}s
                </div>
              )}
            </div>
          )}

          {current.error && (
            <div className={`error-banner ${current.errorType ? `error-${current.errorType}` : ''}`}>
              <span className="error-icon">
                {current.errorType === 'content_policy' ? '🚫' : '!'}
              </span>
              <div className="error-content">
                <span className="error-message">{current.error}</span>
                {generationMode === 'flowith' && lastPrompt && (
                  <button
                    type="button"
                    className="error-retry-btn"
                    onClick={() => {
                      setCurrent(prev => ({ ...prev, error: undefined, errorType: undefined }));
                      if (bulkCount > 1) {
                        generateBulkWithFlowith(lastPrompt, lastImages);
                      } else {
                        generateWithFlowith(lastPrompt, lastImages);
                      }
                    }}
                  >
                    ↻ Retry
                  </button>
                )}
              </div>
            </div>
          )}
        </div>

        <form onSubmit={handleSubmit} className="prompt-form sticky">
          {lastModelTurn && lastModelTurn.outputs.some(o => o.type === 'image') && (
            <div className="edit-hint">
              Continue editing or paste/upload new reference images
            </div>
          )}

          {flowithReplyContext && generationMode === 'flowith' && (
            <div className="flowith-reply-context">
              <div className="reply-context-header">
                <span className="reply-label">↩ Replying to:</span>
                <button 
                  type="button" 
                  className="clear-reply-btn"
                  onClick={handleClearFlowithReply}
                  disabled={current.isGenerating}
                >
                  ×
                </button>
              </div>
              <div className="reply-preview">
                <img src={flowithReplyContext.imageDataUrl} alt="Reply context" />
                <span className="reply-info">{flowithReplyContext.history.length} messages in context</span>
              </div>
            </div>
          )}

          {localReplyContext && generationMode === 'local' && (
            <div className="flowith-reply-context">
              <div className="reply-context-header">
                <span className="reply-label">↩ Replying to:</span>
                <button 
                  type="button" 
                  className="clear-reply-btn"
                  onClick={handleClearLocalReply}
                  disabled={current.isGenerating}
                >
                  ×
                </button>
              </div>
              <div className="reply-preview">
                <img src={localReplyContext.imageDataUrl} alt="Reply context" />
                <span className="reply-info">{localReplyContext.history.length} turns in context</span>
              </div>
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
