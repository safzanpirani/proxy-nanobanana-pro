import { defineConfig, type ViteDevServer } from 'vite'
import react from '@vitejs/plugin-react'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import type { IncomingMessage, ServerResponse } from 'http'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = path.resolve(__dirname, 'data')
const SESSIONS_FILE = path.resolve(DATA_DIR, 'sessions.json')
const SESSIONS_DIR = path.resolve(DATA_DIR, 'sessions')
const IMAGES_DIR = path.resolve(DATA_DIR, 'images')

function ensureDataDirs() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true })
  if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true })
  if (!fs.existsSync(IMAGES_DIR)) fs.mkdirSync(IMAGES_DIR, { recursive: true })
}

function storageApiPlugin() {
  return {
    name: 'storage-api',
    configureServer(server: ViteDevServer) {
      ensureDataDirs()
      console.log('[Storage API] Plugin initialized')
      console.log('[Storage API] DATA_DIR:', DATA_DIR)
      console.log('[Storage API] IMAGES_DIR:', IMAGES_DIR)

      server.middlewares.use('/api/sessions', (req: IncomingMessage, res: ServerResponse) => {
        if (req.method === 'GET') {
          try {
            if (fs.existsSync(SESSIONS_FILE)) {
              const data = fs.readFileSync(SESSIONS_FILE, 'utf-8')
              res.setHeader('Content-Type', 'application/json')
              res.end(data)
            } else {
              res.setHeader('Content-Type', 'application/json')
              res.end('[]')
            }
          } catch (e) {
            res.statusCode = 500
            res.end(JSON.stringify({ error: (e as Error).message }))
          }
        } else if (req.method === 'POST') {
          let body = ''
          req.on('data', (chunk: Buffer) => body += chunk.toString())
          req.on('end', () => {
            try {
              fs.writeFileSync(SESSIONS_FILE, body, 'utf-8')
              res.setHeader('Content-Type', 'application/json')
              res.end('{"ok":true}')
            } catch (e) {
              res.statusCode = 500
              res.end(JSON.stringify({ error: (e as Error).message }))
            }
          })
        } else {
          res.statusCode = 405
          res.end('Method not allowed')
        }
      })

      server.middlewares.use('/api/session/', (req: IncomingMessage, res: ServerResponse) => {
        const id = req.url?.replace('/', '') || ''
        const sessionFile = path.join(SESSIONS_DIR, `${id}.json`)

        if (req.method === 'GET') {
          try {
            if (fs.existsSync(sessionFile)) {
              const data = fs.readFileSync(sessionFile, 'utf-8')
              res.setHeader('Content-Type', 'application/json')
              res.end(data)
            } else {
              res.statusCode = 404
              res.end('{"error":"Not found"}')
            }
          } catch (e) {
            res.statusCode = 500
            res.end(JSON.stringify({ error: (e as Error).message }))
          }
        } else if (req.method === 'POST') {
          let body = ''
          req.on('data', (chunk: Buffer) => body += chunk.toString())
          req.on('end', () => {
            try {
              fs.writeFileSync(sessionFile, body, 'utf-8')
              res.setHeader('Content-Type', 'application/json')
              res.end('{"ok":true}')
            } catch (e) {
              res.statusCode = 500
              res.end(JSON.stringify({ error: (e as Error).message }))
            }
          })
        } else if (req.method === 'DELETE') {
          try {
            if (fs.existsSync(sessionFile)) fs.unlinkSync(sessionFile)
            res.setHeader('Content-Type', 'application/json')
            res.end('{"ok":true}')
          } catch (e) {
            res.statusCode = 500
            res.end(JSON.stringify({ error: (e as Error).message }))
          }
        } else {
          res.statusCode = 405
          res.end('Method not allowed')
        }
      })

      // Handle /api/images - MUST come before /api/images/ to properly handle POST
      server.middlewares.use('/api/images', (req: IncomingMessage, res: ServerResponse, next: () => void) => {
        // Extract the path after /api/images
        const urlPath = req.url || ''
        const imageId = urlPath.replace(/^\//, '')

        console.log(`[Storage API] /api/images - method=${req.method}, url=${req.url}, imageId="${imageId}"`)

        // POST to /api/images (no id) = save new image
        if (req.method === 'POST' && !imageId) {
          console.log('[Storage API] Handling POST to save new image')
          let body = ''
          req.on('data', (chunk: Buffer) => body += chunk.toString())
          req.on('end', () => {
            try {
              console.log(`[Storage API] Received body length: ${body.length}`)
              const { dataUrl } = JSON.parse(body)
              if (!dataUrl) {
                console.log('[Storage API] ERROR: No dataUrl provided')
                res.statusCode = 400
                res.end('{"error":"No dataUrl provided"}')
                return
              }

              console.log(`[Storage API] dataUrl length: ${dataUrl.length}`)
              const base64Match = dataUrl.match(/^data:image\/\w+;base64,(.+)$/)
              if (!base64Match) {
                console.log('[Storage API] ERROR: Invalid data URL format')
                res.statusCode = 400
                res.end('{"error":"Invalid data URL"}')
                return
              }

              const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
              const buffer = Buffer.from(base64Match[1], 'base64')
              const imageFile = path.join(IMAGES_DIR, `${id}.webp`)
              
              console.log(`[Storage API] Writing image to: ${imageFile} (${buffer.length} bytes)`)
              fs.writeFileSync(imageFile, buffer)
              console.log(`[Storage API] Image saved successfully: ${id}`)
              
              res.setHeader('Content-Type', 'application/json')
              res.end(JSON.stringify({ id, url: `/api/images/${id}` }))
            } catch (e) {
              console.error('[Storage API] ERROR saving image:', e)
              res.statusCode = 500
              res.end(JSON.stringify({ error: (e as Error).message }))
            }
          })
          return
        }

        // GET /api/images/:id = retrieve image
        if (req.method === 'GET' && imageId) {
          const imageFile = path.join(IMAGES_DIR, `${imageId}.webp`)
          console.log(`[Storage API] GET image: ${imageFile}`)
          
          try {
            if (fs.existsSync(imageFile)) {
              const data = fs.readFileSync(imageFile)
              console.log(`[Storage API] Serving image: ${imageId} (${data.length} bytes)`)
              res.setHeader('Content-Type', 'image/webp')
              res.setHeader('Cache-Control', 'public, max-age=31536000')
              res.end(data)
            } else {
              console.log(`[Storage API] Image not found: ${imageFile}`)
              res.statusCode = 404
              res.end('Not found')
            }
          } catch (e) {
            console.error('[Storage API] ERROR reading image:', e)
            res.statusCode = 500
            res.end((e as Error).message)
          }
          return
        }

        // Pass to next middleware if not handled
        next()
      })
    }
  }
}

export default defineConfig({
  plugins: [react(), storageApiPlugin()],
  server: {
    host: true
  }
})
