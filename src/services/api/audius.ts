// ============================================================
// Audius — catálogo grande, con API oficial (a diferencia de
// NetEase, sin firma que expira, sin CORS, sin bloqueo geográfico
// ni VIP). El catálogo son artistas independientes que suben a la
// plataforma, no Top 40 comercial, pero es enorme y crece rápido.
//
// Desde 2026 los tracks son accesibles por API por defecto (Open
// Music License) salvo que el artista lo desactive — por eso no
// hace falta "resolver" una URL de streaming aparte como con
// NetEase: /tracks/:id/stream YA es la URL reproducible/descargable
// final y no expira.
//
// No hace falta API key para empezar (rate limit más bajo). Para
// más límite: registrar una gratis en https://api.audius.co/plans
// y ponerla en API_KEY de abajo.
// ============================================================

import { fetchJsonRobust } from '@shared/lib/httpClient'

const BASE_URL = 'https://api.audius.co/v1'
const APP_NAME = 'XFY'
const API_KEY = '' // opcional — ver comentario arriba

const CACHE_KEY = 'xfy_audius_cache_v1'
const CACHE_TTL_MS = 1000 * 60 * 30 // 30 min para listados (trending/search cambia)

/** Track de Audius ya mapeado al shape interno de canción XFY. */
export interface AudiusTrack {
  id: string
  title: string
  artist: string
  album: string
  albumArtUrl: string | null
  audioSrc: string
  lyrics: never[]
  audiusId: string
  isExternal: true
  source: 'audius'
  downloadable: boolean
  durationSec: number
  artistHandle: string | null
  artistAvatarUrl: string | null
}

interface AudiusUser {
  id: string
  name: string
  handle: string
  bio?: string
  profile_picture?: Record<string, string>
  follower_count?: number
  track_count?: number
}

type AudiusCache = Record<string, { value: unknown; fetchedAt: number }>

function readCache(): AudiusCache {
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    return raw ? (JSON.parse(raw) as AudiusCache) : {}
  } catch {
    return {}
  }
}

function writeCache(cache: AudiusCache): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(cache))
  } catch {
    // no crítico
  }
}

function buildUrl(path: string, params: Record<string, string | number | null | undefined> = {}) {
  const url = new URL(`${BASE_URL}${path}`)
  url.searchParams.set('app_name', APP_NAME)
  if (API_KEY) url.searchParams.set('api_key', API_KEY)
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value))
  }
  return url.toString()
}

async function fetchJson<T = unknown>(path: string, params: Record<string, string | number | null | undefined> = {}): Promise<T | undefined> {
  const json = await fetchJsonRobust<{ data?: T }>(buildUrl(path, params), { timeoutMs: 10000, retries: 1 })
  return json?.data
}

// Los géneros que expone Audius para filtrar trending/búsqueda (los más
// usados — la lista completa es más larga, pero esto alcanza para chips
// de género en el Descubre).
export const AUDIUS_GENRES = [
  'Electronic',
  'Hip-Hop/Rap',
  'Pop',
  'Rock',
  'R&B/Soul',
  'Alternative',
  'Ambient',
  'Lo-Fi',
]

interface AudiusRawTrack {
  id?: string
  title?: string
  genre?: string
  downloadable?: boolean
  duration?: number
  artwork?: Record<string, string>
  user?: { name?: string; handle?: string; profile_picture?: Record<string, string> }
}

function mapTrack(raw: AudiusRawTrack | null | undefined): AudiusTrack | null {
  if (!raw?.id) return null
  const streamUrl = buildUrl(`/tracks/${raw.id ?? ''}/stream`)
  // Si el artista marcó el track como descargable, ese endpoint sirve el
  // archivo original que subió (sin la transcodificación que aplica
  // /stream) — mejor calidad real cuando está disponible; si no, cae al
  // stream normal, que sigue siendo la URL final y no expira.
  const audioSrc = raw.downloadable ? buildUrl(`/tracks/${raw.id ?? ''}/download`) : streamUrl
  return {
    id: `audius:${raw.id}`,
    title: raw.title || 'Sin título',
    artist: raw.user?.name || raw.user?.handle || 'Artista desconocido',
    album: raw.genre || 'Audius',
    // Audius manda 3 tamaños por portada (150/480/1000) — se pedía el de
    // 480 primero y el de 1000 quedaba de último recurso, así que nunca
    // se usaba salvo que 480 faltara. Se invierte el orden: siempre el
    // más grande disponible primero.
    albumArtUrl: raw.artwork?.['1000x1000'] || raw.artwork?.['480x480'] || raw.artwork?.['150x150'] || null,
    // Original sin transcodificar cuando el artista lo permite; si no,
    // el stream transcodificado — de cualquier forma, no expira.
    audioSrc,
    lyrics: [],
    audiusId: raw.id,
    isExternal: true,
    source: 'audius',
    downloadable: !!raw.downloadable,
    durationSec: raw.duration || 0,
    artistHandle: raw.user?.handle || null,
    artistAvatarUrl:
      raw.user?.profile_picture?.['1000x1000'] ||
      raw.user?.profile_picture?.['480x480'] ||
      raw.user?.profile_picture?.['150x150'] ||
      null,
  }
}

async function cachedList(cacheKey: string, fetcher: () => Promise<unknown>): Promise<AudiusTrack[]> {
  const cache = readCache()
  const cached = cache[cacheKey]
  const cachedHit = cached?.value as AudiusTrack[] | undefined
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cachedHit ?? []

  try {
    const list = await fetcher()
    const list2 = (list || []) as AudiusRawTrack[]
    const value = list2.map(mapTrack).filter((t): t is AudiusTrack => t !== null)
    cache[cacheKey] = { value, fetchedAt: Date.now() }
    writeCache(cache)
    return value
  } catch (e) {
    console.warn('[XFY] Audius search falló')
    return (cached?.value as AudiusTrack[]) ?? []
  }
}

export function getTrendingTracks(genre: string | null = null, limit = 30): Promise<AudiusTrack[]> {
  const key = `trending:${genre || 'all'}:${limit}`
  return cachedList(key, () => fetchJson('/tracks/trending', { genre, limit }))
}

export function searchTracks(query: string | null | undefined, limit = 20): Promise<AudiusTrack[]> {
  if (!query?.trim()) return Promise.resolve([])
  const key = `search:${query.toLowerCase().trim()}:${limit}`
  return cachedList(key, () => fetchJson('/tracks/search', { query, limit }))
}

export async function getTrackById(audiusId: string): Promise<AudiusTrack | null> {
  const key = `track:${audiusId}`
  const cache = readCache()
  const cached = cache[key]
  const cachedHit = cached?.value as AudiusTrack | null | undefined
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cachedHit ?? null

  try {
    const data = await fetchJson<AudiusRawTrack | AudiusRawTrack[]>(`/tracks/${audiusId}`)
    const value = mapTrack(Array.isArray(data) ? data[0] : data)
    cache[key] = { value, fetchedAt: Date.now() }
    writeCache(cache)
    return value
  } catch (e) {
    console.warn('[XFY] Audius getTrackById falló')
    return (cached?.value as AudiusTrack | null) ?? null
  }
}

// URL de streaming — siempre disponible, sirve para reproducir Y para
// cachear/descargar (ver downloadQueue.js). No expira.
export function getStreamUrl(audiusId: string): string {
  return buildUrl(`/tracks/${audiusId}/stream`)
}

// Solo si el artista marcó el track como descargable explícitamente
// (raw.downloadable) hay un original sin transcodificar disponible acá.
// Si no, usar getStreamUrl igual sirve para tener copia local para
// reproducción offline propia.
export function getOriginalDownloadUrl(audiusId: string): string {
  return buildUrl(`/tracks/${audiusId}/download`)
}

export async function searchArtists(query: string | null | undefined, limit = 5) {
  if (!query?.trim()) return []
  const key = `artist-search:${query.toLowerCase().trim()}:${limit}`
  const cache = readCache()
  const cached = cache[key]
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached.value

  try {
    const data = await fetchJson<AudiusUser[]>('/users/search', { query, limit })
    const users = (data || []) as AudiusUser[]
    const value = users.map((u) => ({
      id: u.id,
      name: u.name,
      handle: u.handle,
      bio: u.bio || null,
      avatarUrl: u.profile_picture?.['1000x1000'] || u.profile_picture?.['480x480'] || u.profile_picture?.['150x150'] || null,
      followerCount: u.follower_count || 0,
      trackCount: u.track_count || 0,
    }))
    cache[key] = { value, fetchedAt: Date.now() }
    writeCache(cache)
    return value
  } catch (e) {
    console.warn('[XFY] Audius searchArtists falló')
    return cached?.value || []
  }
}

export async function getArtistTracks(userId: string, limit = 12): Promise<AudiusTrack[]> {
  const key = `artist-tracks:${userId}:${limit}`
  return cachedList(key, () => fetchJson(`/users/${userId}/tracks`, { limit }))
}
