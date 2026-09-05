// ============================================================
// Piped como plugin de fuente — inspirado directamente en cómo Spotube
// usa Piped/Invidious como frontend alternativo de YouTube.
//
// A diferencia de ytmusicSource (que apunta a nuestro propio pipeline
// de extracción con BotGuard), este plugin habla directo con una
// instancia pública de Piped. Sirve para DOS cosas:
//   1. Como fuente de búsqueda propia si el usuario la habilita en
//      Ajustes → Fuentes (capabilities.search).
//   2. Como fallback de servidor cuando el pipeline de youtubei.js está
//      bloqueado por bot-detection — ver api/_lib/pipedFallback.ts,
//      que usa la MISMA lista de instancias pero desde el server.
//
// Instancias públicas rotan disponibilidad seguido; se prueban en orden
// y se seguimos a la próxima ante cualquier error, sin tirar.
// ============================================================

import type { MusicSourcePlugin } from '../types'
import type { Song } from '@/types/models'

export const PIPED_INSTANCES = [
  'https://pipedapi.kavin.rocks',
  'https://api.piped.yt',
  'https://piped-api.lunar.icu',
  'https://pipedapi.adminforge.de',
]

interface PipedSearchItem {
  url?: string // "/watch?v=XXXXXXXXXXX"
  title?: string
  uploaderName?: string
  thumbnail?: string
  duration?: number
}

function videoIdFromUrl(url?: string): string | null {
  const match = /[?&]v=([A-Za-z0-9_-]{11})/.exec(url || '')
  return match?.[1] || null
}

async function fetchFromAnyInstance<T>(path: string): Promise<T | null> {
  for (const instance of PIPED_INSTANCES) {
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 5000)
      const res = await fetch(`${instance}${path}`, { signal: controller.signal })
      clearTimeout(timer)
      if (!res.ok) continue
      return (await res.json()) as T
    } catch {
      continue // esta instancia está caída/lenta — probamos la siguiente
    }
  }
  return null
}

export const pipedSource: MusicSourcePlugin = {
  id: 'piped',
  name: 'Piped (YouTube alternativo)',
  capabilities: { search: true, artistSearch: false, resolveStream: true },
  search: async (query, limit = 20) => {
    const data = await fetchFromAnyInstance<{ items?: PipedSearchItem[] }>(
      `/search?q=${encodeURIComponent(query)}&filter=music_songs`,
    )
    const items = data?.items || []
    return items
      .map((item) => videoIdFromUrl(item.url) && item)
      .filter((x): x is PipedSearchItem => !!x)
      .slice(0, limit)
      .map(
        (item): Song => ({
          id: videoIdFromUrl(item.url) as string,
          videoId: videoIdFromUrl(item.url) as string,
          title: item.title || 'Sin título',
          artist: item.uploaderName || 'Desconocido',
          albumArtUrl: item.thumbnail || null,
          source: 'piped',
          duration: item.duration,
        }),
      )
  },
  resolveStream: async (videoId) => {
    const data = await fetchFromAnyInstance<{
      audioStreams?: { url: string; mimeType?: string; bitrate?: number }[]
    }>(`/streams/${videoId}`)
    const streams = data?.audioStreams || []
    if (!streams.length) return null
    const best = [...streams].sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0]
    if (!best) return null
    return { url: best.url, mimeType: best.mimeType, viaFallback: true }
  },
}
