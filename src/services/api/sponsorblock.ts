// ============================================================
// SponsorBlock — salteo automático de segmentos de sponsor/intro/outro
// en las canciones que vienen de YouTube. La misma idea de Spotube (que
// integra SponsorBlock para saltar sponsors en los videos que usa como
// fuente de audio) aplica directo acá: XFY reproduce audio extraído de
// YouTube, así que cualquier canción con un sponsor insertado (remixes,
// videos de canales que insertan promos) se beneficia igual.
//
// API pública, sin auth: https://wiki.sponsor.ajay.app/w/API_Docs
// Categorías pedidas: sponsor, selfpromo, interaction (no "music_offtopic"
// ni "outro"/"intro" completos — esas a veces SON parte de la canción en
// videos musicales, así que se dejan afuera para no cortar contenido real).
// ============================================================

import { fetchJsonRobust } from '@shared/lib/httpClient'

const API_BASE = 'https://sponsor.ajay.app/api'
const CACHE_KEY = 'xfy_sponsorblock_cache_v1'
const CACHE_TTL_MS = 1000 * 60 * 60 * 24 * 7 // los segmentos casi no cambian una vez votados
const CATEGORIES = ['sponsor', 'selfpromo', 'interaction'] as const

export interface SponsorSegment {
  startSec: number
  endSec: number
  category: string
}

interface RawSegment {
  segment: [number, number]
  category: string
}

type SponsorCache = Record<string, { value: SponsorSegment[]; fetchedAt: number }>

function readCache(): SponsorCache {
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    return raw ? JSON.parse(raw) : {}
  } catch {
    return {}
  }
}

function writeCache(cache: SponsorCache): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(cache))
  } catch {
    // no-op: cache best-effort, un fallo de escritura solo implica re-pedir después
  }
}

/** Segmentos de sponsor/self-promo/interacción para un videoId, cacheados
 *  7 días en localStorage. Devuelve [] (nunca tira) si SponsorBlock no
 *  tiene datos para ese video — es lo esperado para la mayoría de las
 *  canciones, no un error. */
export async function getSponsorSegments(videoId: string): Promise<SponsorSegment[]> {
  if (!videoId) return []
  const cache = readCache()
  const cached = cache[videoId]
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached.value

  try {
    const categoriesParam = encodeURIComponent(JSON.stringify(CATEGORIES))
    const raw = await fetchJsonRobust<RawSegment[]>(
      `${API_BASE}/skipSegments?videoID=${videoId}&categories=${categoriesParam}`,
    )
    const segments: SponsorSegment[] = Array.isArray(raw)
      ? raw.map((s) => ({ startSec: s.segment[0], endSec: s.segment[1], category: s.category }))
      : []
    cache[videoId] = { value: segments, fetchedAt: Date.now() }
    writeCache(cache)
    return segments
  } catch {
    // 404 es la respuesta normal de SponsorBlock cuando no hay segmentos
    // reportados para el video — se cachea como [] igual para no
    // repreguntar en cada reproducción.
    cache[videoId] = { value: [], fetchedAt: Date.now() }
    writeCache(cache)
    return []
  }
}

const ENABLED_KEY = 'xfy_sponsorblock_enabled'

export function isSponsorBlockEnabled(): boolean {
  try {
    return localStorage.getItem(ENABLED_KEY) !== '0' // habilitado por default
  } catch {
    return true
  }
}

export function setSponsorBlockEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(ENABLED_KEY, enabled ? '1' : '0')
  } catch {
    // no-op
  }
}

/** Dado el tiempo actual de reproducción, ¿cae dentro de algún segmento?
 *  Devuelve el segmento (para poder saltar a su `endSec`) o null. */
export function findActiveSegment(segments: SponsorSegment[], currentTimeSec: number): SponsorSegment | null {
  return segments.find((s) => currentTimeSec >= s.startSec && currentTimeSec < s.endSec - 0.25) || null
}
