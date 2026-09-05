// ============================================================
// Fallback cruzado de FUENTE completa — inspirado en cómo Spotube nunca
// se queda pegado a un solo proveedor: si YouTube (ytmusicSource, con
// TODA su cadena interna youtubei.js → muxed → Piped server-side) falla
// de punta a punta para una canción, en vez de quedarnos sonando por el
// IFrame indefinidamente (que YouTube pausa solo al ir a background/
// bloquear el celular, ver usePlayerStore._playViaIframe) probamos
// resolver la MISMA canción en otra fuente registrada por completo
// (Piped como frontend alternativo, Audius, o cualquier plugin nuevo).
//
// Dos ideas de Spotube que se combinan acá:
//   1. Múltiples fuentes intercambiables detrás de una interfaz común
//      (MusicSourcePlugin, ver types.ts) — ya existía en el registry,
//      pero nunca se usaba fuera de Ajustes → Fuentes. Este módulo es
//      el primer consumidor real en el camino de reproducción.
//   2. Fuzzy matching (songSimilarity/isFuzzySameSong) para confirmar
//      que el resultado de OTRA fuente es de verdad la misma canción y
//      no un cover/remix/versión en vivo — nunca reproducimos a ciegas
//      el primer resultado de una búsqueda ajena.
//
// Circuit breaker: si una fuente falla repetido en poco tiempo (instancia
// pública de Piped caída, Audius con timeout) se la salta durante un
// rato en vez de perder segundos probándola en cada canción — mismo
// patrón de "penalizar fuentes que no responden" que Spotube aplica al
// rotar entre instancias/proveedores.
// ============================================================

import { getEnabledSourcePlugins } from './registry'
import { isFuzzySameSong, primaryArtistName, type SongLike } from '@shared/lib/songIdentity'
import type { MusicSourcePlugin, ResolvedStream } from './types'

const HEALTH_KEY = 'xfy_source_health'
const FAILURE_THRESHOLD = 3 // fallos seguidos antes de abrir el circuito
const COOLDOWN_MS = 10 * 60 * 1000 // 10 min de "descanso" tras abrirse

interface HealthEntry {
  failures: number
  openedAt?: number // timestamp de cuando se abrió el circuito, si está abierto
}

function readHealth(): Record<string, HealthEntry> {
  try {
    const raw = sessionStorage.getItem(HEALTH_KEY)
    return raw ? (JSON.parse(raw) as Record<string, HealthEntry>) : {}
  } catch {
    return {}
  }
}

function writeHealth(health: Record<string, HealthEntry>): void {
  try {
    sessionStorage.setItem(HEALTH_KEY, JSON.stringify(health))
  } catch {
    // no-op: sin persistencia de salud no pasa nada grave, solo se
    // vuelve a probar cada fuente en cada canción.
  }
}

function isCircuitOpen(pluginId: string): boolean {
  const entry = readHealth()[pluginId]
  if (!entry?.openedAt) return false
  return Date.now() - entry.openedAt < COOLDOWN_MS
}

function recordFailure(pluginId: string): void {
  const health = readHealth()
  const entry = health[pluginId] ?? { failures: 0 }
  entry.failures += 1
  if (entry.failures >= FAILURE_THRESHOLD) entry.openedAt = Date.now()
  health[pluginId] = entry
  writeHealth(health)
}

function recordSuccess(pluginId: string): void {
  const health = readHealth()
  if (health[pluginId]) delete health[pluginId] // circuito limpio de nuevo
  writeHealth(health)
}

export interface AlternateStream extends ResolvedStream {
  sourceId: string
  sourceName: string
}

/**
 * Busca la misma canción en cualquier fuente registrada que NO sea
 * `excludeSourceId` (normalmente 'ytmusic', que ya agotó su propia
 * cadena de fallback interna) y devuelve el primer stream que:
 *   a) matchea por fuzzy matching con la canción pedida (evita covers/
 *      versiones en vivo con título parecido), y
 *   b) resuelve a una URL de audio reproducible de verdad.
 *
 * Prueba las fuentes EN SECUENCIA (no en paralelo): la primera que
 * responde bien corta la cadena ahí, así no se gastan resoluciones de
 * más de una fuente para nada. Fuentes con el circuito abierto se
 * saltan sin red trip.
 */
export async function findAlternateStream(
  song: SongLike,
  excludeSourceId: string,
): Promise<AlternateStream | null> {
  const candidates = getEnabledSourcePlugins().filter(
    (p): p is MusicSourcePlugin =>
      p.id !== excludeSourceId && p.capabilities.search && p.capabilities.resolveStream && !isCircuitOpen(p.id),
  )
  if (!candidates.length) return null

  const query = `${song.title ?? ''} ${primaryArtistName(song)}`.trim()
  if (!query) return null

  for (const plugin of candidates) {
    try {
      const results = await plugin.search!(query, 5)
      const match = results.find((r) => isFuzzySameSong(song, r, 0.72))
      if (!match) {
        // No es un error de la fuente (respondió bien, solo no tenía la
        // canción) — no cuenta como fallo para el circuit breaker.
        continue
      }
      const streamId = match.videoId || String(match.id)
      const stream = await plugin.resolveStream!(streamId)
      if (!stream?.url) {
        recordFailure(plugin.id)
        continue
      }
      recordSuccess(plugin.id)
      return { ...stream, sourceId: plugin.id, sourceName: plugin.name }
    } catch {
      recordFailure(plugin.id)
      continue
    }
  }
  return null
}
