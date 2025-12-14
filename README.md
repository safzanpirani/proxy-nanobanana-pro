# Gemini 3 Pro Image Studio

A sleek, neo-brutalist UI for Google's Gemini 3 Pro Image model. Generate and iteratively edit images through multi-turn conversations.

![Gemini 3 Pro Image Studio](https://img.shields.io/badge/Gemini-3_Pro_Image-c8ff00?style=for-the-badge)

## Features

- **Multi-turn Image Generation** - Have a conversation with the model to iteratively refine images
- **Image Input Support** - Upload up to 14 reference images or paste from clipboard (Ctrl+V)
- **Resolution Control** - Generate at 1K, 2K, or 4K resolution
- **Aspect Ratios** - Choose from 1:1, 16:9, 9:16, 4:3, 3:4, 21:9
- **Google Search Grounding** - Optional web grounding for more accurate generations
- **Session History** - Auto-saves sessions with thumbnails to localStorage
- **Image Lightbox** - Click any image to view full-size with prompt and generation stats
- **Per-Image Regeneration** - Regenerate specific images without losing conversation context
- **WebP Storage** - Efficient image storage with progressive quality fallback

## Requirements

This app connects to a local Gemini API proxy running at `localhost:8317`. You'll need:

1. A Gemini API proxy that forwards requests to `generativelanguage.googleapis.com`
2. The proxy should expose the `/v1beta` endpoint
3. Model: `gemini-3-pro-image-preview`

## Setup

```bash
# Install dependencies
npm install

# Start development server
npm run dev

# Build for production
npm run build
```

## Usage

1. Start your Gemini API proxy on port 8317
2. Run the app with `npm run dev`
3. Open `http://localhost:5173`
4. Enter a prompt and click GO to generate
5. Continue the conversation to edit/refine the image
6. Use the action buttons under each image:
   - **↗ Open** - View full-size in new tab
   - **↓ Download** - Save as WebP
   - **↻ Regen** - Regenerate with same prompt

## Tech Stack

- React 19 + TypeScript
- Vite
- Google GenAI SDK (`@google/genai`)
- Neo-brutalist design with Instrument Serif, Space Mono, DM Sans fonts

## API Configuration

The app connects to:
```
http://localhost:8317/v1beta/models/gemini-3-pro-image-preview
```

Modify `src/lib/ai.ts` to change the endpoint or model.

## License

MIT
