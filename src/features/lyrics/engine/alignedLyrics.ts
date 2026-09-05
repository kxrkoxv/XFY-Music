// Caché de letras alineadas — persistencia DURABLE en IndexedDB (ver
// lyricsCache.ts). El timing palabra-a-palabra que llega acá ya NO viene
// de un servicio externo: sale del propio LRCLIB cuando el track trae
// Enhanced LRC (timestamps por palabra reales), que es la fuente gratuita
// y sin claves que usa todo el pipeline. Este módulo solo se ocupa de que,
// una vez obtenidas, sobrevivan a cerrar la pestaña y al storage HTTP.

import type { WordTiming } from './wordTiming'
import type { SyncedLine } from './lrclib'
import { readLyricCache, writeLyricCache } from './lyricsCache'

/** Línea con timing por palabra real (Enhanced LRC). */
export type AlignedLine = SyncedLine & { words?: WordTiming[] }

/**
 * Devuelve el timing palabra-a-palabra cacheado en ESTE navegador, sin
 * red — la primera cosa que LyricsPanel chequea al cambiar de canción.
 */
export async function getCachedAlignment(
  trackId: string | null | undefined,
): Promise<AlignedLine[] | null> {
  if (!trackId) return null
  const cached = await readLyricCache<AlignedLine[] | null>(`align:${trackId}`)
  return cached ?? null
}

/** Guarda timing palabra-a-palabra para una canción (durable). */
export async function cacheAlignment(trackId: string, lines: AlignedLine[]): Promise<void> {
  await writeLyricCache(`align:${trackId}`, lines)
}
