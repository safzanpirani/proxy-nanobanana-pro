export interface SessionMeta {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  thumbnail?: string;
  turnCount: number;
}

export async function getAllSessionsMeta(): Promise<SessionMeta[]> {
  try {
    const res = await fetch('/api/sessions')
    if (res.ok) return await res.json()
  } catch (e) {
    console.warn('Failed to load sessions from server:', e)
  }
  return []
}

export async function saveAllSessionsMeta(sessions: SessionMeta[]): Promise<void> {
  try {
    await fetch('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(sessions)
    })
  } catch (e) {
    console.warn('Failed to save sessions to server:', e)
  }
}

export async function saveSessionMeta(meta: SessionMeta): Promise<void> {
  const sessions = await getAllSessionsMeta()
  const existing = sessions.findIndex(s => s.id === meta.id)
  if (existing >= 0) {
    sessions[existing] = meta
  } else {
    sessions.unshift(meta)
  }
  await saveAllSessionsMeta(sessions)
}

export async function deleteSessionMeta(id: string): Promise<void> {
  const sessions = await getAllSessionsMeta()
  const filtered = sessions.filter(s => s.id !== id)
  await saveAllSessionsMeta(filtered)
}

export async function getSession(id: string): Promise<unknown | null> {
  try {
    const res = await fetch(`/api/session/${id}`)
    if (res.ok) return await res.json()
  } catch (e) {
    console.warn('Failed to load session:', e)
  }
  return null
}

export async function saveSession(id: string, data: unknown): Promise<void> {
  try {
    await fetch(`/api/session/${id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    })
  } catch (e) {
    console.warn('Failed to save session:', e)
  }
}

export async function deleteSession(id: string): Promise<void> {
  try {
    await fetch(`/api/session/${id}`, { method: 'DELETE' })
  } catch (e) {
    console.warn('Failed to delete session:', e)
  }
}

export async function saveImage(dataUrl: string): Promise<string> {
  try {
    const res = await fetch('/api/images', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dataUrl })
    })
    if (res.ok) {
      const { id } = await res.json()
      return id
    }
  } catch (e) {
    console.warn('Failed to save image:', e)
  }
  throw new Error('Failed to save image')
}

export function getImageUrl(id: string): string {
  return `/api/images/${id}`
}

export async function getImage(id: string): Promise<string | null> {
  return getImageUrl(id)
}
