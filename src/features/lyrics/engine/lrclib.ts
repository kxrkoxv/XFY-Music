// Cliente directo a LRCLIB (https://lrclib.net) — reemplaza al backend
// local (localhost:4001) como fuente principal de letras.
//
// Por qué: el backend local dependía de que vos lo tuvieras corriendo, y
// aunque lo tuvieras corriendo, un solo intento con "duration" exacto
// fallaba silenciosamente para varias canciones (por eso "algunas letras
// tienen problema"). LRCLIB es pública, gratuita, no pide API key, tiene
// CORS habilitado (se puede llamar directo desde el navegador) y una
// base de datos mucho más grande que cualquier proxy casero.
//
// Estrategia para que NO fallen:
//   1. /api/get con duración exacta (más preciso, si tenés song.duration)
//   2. si falla → /api/search y elegimos el mejor candidato (con letra
//      sincronizada, duración más cercana)
//   3. si el mejor candidato solo tiene letra plana (sin timing), la
//      usamos igual repartiendo el tiempo parejo entre líneas — mejor
//      tener la letra completa sin sync perfecto que no tener letra
//      - 1 reintento automático si fue un error de red (no si fue "no
//        encontrado", eso no tiene sentido reintentarlo)
//   4. resultado cacheado en memoria + sessionStorage por canción, así
//      no se vuelve a pedir cada vez que volvés a esa canción
//
// Docs: https://lrclib.net/docs

import type { WordTiming } from './wordTiming'
import { readLyricCache, writeLyricCache } from './lyricsCache'
import { normalizeText } from '@shared/lib/audioCacheKey'

/** Línea con timing por línea (y opcionalmente por palabra) — mismo shape
 *  que produce parseTTML.ts y consume LyricsPanel/LyricLine sin adaptador. */
export interface SyncedLine {
  time: number
  text: string
  words?: WordTiming[]
}

/** Resultado de una búsqueda exitosa de letra. */
export interface LRCLIBResult {
  lines: SyncedLine[]
  synced: boolean
  source: string
  /** LRCLIB marcó el track como instrumental: no hay letra que buscar. */
  instrumental?: boolean
}

interface LRCLIBQuery {
  title: string
  artist: string
  album?: string | null
  duration?: number | null
  /** Letras planas ya conocidas (ej. de YT Music): sus anchors de tiempo se
   *  reusan al sintetizar timing para la letra plana de LRCLIB. */
  fallbackLyrics?: { time: number; text: string }[]
  signal?: AbortSignal
}

/** Registro de la API de LRCLIB (campos relevantes para este cliente). */
interface LRCLIBRecord {
  trackName?: string | null
  artistName?: string | null
  albumName?: string | null
  duration?: number | null
  instrumental?: boolean | null
  plainLyrics?: string | null
  syncedLyrics?: string | null
}

const BASE_URL = 'https://lrclib.net/api'

/**
 * Clave de caché por IDENTIDAD canónica de canción (título+artista
 * normalizados sin acentos/puntuación), no por query cruda: así "DÁKITI"
 * y "Dakiti (feat. Bad Bunny)" del mismo artista comparten entrada, y un
 * videoId distinto de la misma canción no re-paga la búsqueda.
 */
function cacheKey(title: string, artist: string): string {
  return `lrclib:${normalizeText(title)}::${normalizeText(artist)}`
}

// Ruido típico de títulos "tal cual vienen de YouTube/metadata" que
// arruina el match exacto contra LRCLIB (que indexa el título "limpio"
// del track original): sufijos entre paréntesis/corchetes tipo
// "(Official Video)", "(Lyric Video)", "(Audio)", "(Live)",
// "(Remastered 2011)", "- Single Version", featuring, etc.
// Se usa SOLO como segundo intento si la búsqueda con el título crudo no
// encontró nada — así no perdemos matches donde el paréntesis sí forma
// parte real del título (ej. "Under Pressure (Rescue Me)").
const NOISE_PARENS = /\s*[([][^)\]]*?\b(official|video|audio|lyric|lyrics|visualizer|remaster(ed)?|live|mono|stereo|explicit|clean|radio edit|single version|bonus track|deluxe|mv)\b[^)\]]*?[)\]]/gi
const NOISE_SUFFIX = /\s*[-–—]\s*(remaster(ed)?( \d{4})?|live( at .*)?|single version|radio edit|mono version|stereo version|from ".*"|bonus track|explicit|clean)\s*$/gi
const FEAT_TAG = /\s*[([]?\b(feat\.?|ft\.?|featuring|with)\b[^)\]]*[)\]]?\s*$/i

function stripNoise(text: unknown): string {
  return String(text || '')
    .replace(NOISE_PARENS, ' ')
    .replace(NOISE_SUFFIX, ' ')
    .replace(FEAT_TAG, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

function parseTimeTag(min: string, sec: string, frac?: string): number {
  const minutes = Number(min)
  const seconds = Number(sec)
  const fraction = frac ? Number(frac.padEnd(3, '0')) / 1000 : 0
  return minutes * 60 + seconds + fraction
}

// Timestamp por palabra dentro de una línea: "<mm:ss.xx>" (a veces
// "<mm:ss.xx>palabra" repetido por cada palabra). Es la extensión
// "Enhanced LRC" / A2 que usan Musixmatch y algunos uploads de LRCLIB —
// cuando está presente, da timing REAL por palabra en vez del estimado
// que arma wordTiming.js repartiendo la línea por longitud de palabra.
const WORD_TAG = /<(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?>/g

// Parsea una línea de LRC "enhanced" con timestamps por palabra, si los
// tiene. Devuelve null si la línea no usa este formato (LRC normal).
function parseWordTags(textWithTags: string, lineStart: number, lineEnd?: number | null): WordTiming[] | null {
  const tags = [...textWithTags.matchAll(WORD_TAG)]
  if (tags.length === 0) return null

  const words: WordTiming[] = []
  for (let i = 0; i < tags.length; i++) {
    const tag = tags[i]!
    const start = parseTimeTag(tag[1]!, tag[2]!, tag[3])
    const nextTag = tags[i + 1]
    const end = nextTag ? parseTimeTag(nextTag[1]!, nextTag[2]!, nextTag[3]) : (lineEnd ?? start + 0.4)
    const segmentEnd = nextTag?.index ?? textWithTags.length
    const text = textWithTags.slice((tag.index ?? 0) + tag[0].length, segmentEnd).trim()
    if (text) words.push({ text, start, end })
  }
  return words.length > 0 ? words : null
}

// Parsea el formato LRC crudo que devuelve LRCLIB ("[mm:ss.xx] texto",
// con soporte para líneas con más de un timestamp — típico en estribillos
// repetidos) al shape { time, text, words? } que ya usa LyricsPanel.
// Cuando la línea trae timestamps por palabra (Enhanced LRC), `words`
// queda poblado con timing exacto y LyricLine lo usa directo en vez de
// estimarlo.
export function parseLRC(raw: string): SyncedLine[] {
  const lines: SyncedLine[] = []
  const timeTag = /\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]/g

  for (const rawLine of raw.split('\n')) {
    const tags = [...rawLine.matchAll(timeTag)]
    if (tags.length === 0) continue // metadata ([ar:], [ti:], etc.) o línea vacía

    const rawText = rawLine.replace(timeTag, '').trim()
    if (!rawText) continue // timestamp sin texto (ej. marca de instrumental): se ignora

    const plainText = rawText.replace(WORD_TAG, '').trim()
    if (!plainText) continue

    for (const tag of tags) {
      const time = parseTimeTag(tag[1]!, tag[2]!, tag[3])
      const words = parseWordTags(rawText, time)
      lines.push(words ? { time, text: plainText, words } : { time, text: plainText })
    }
  }

  return lines.sort((a, b) => a.time - b.time)
}

// Fallback cuando solo hay letra plana (sin timing): reparte las líneas
// parejo a lo largo de la duración de la canción, así al menos se ve la
// letra completa en vez de nada. Se exporta porque LyricsPanel la
// reusa también para el respaldo de letras planas de YT Music (ver ahí).
function estimatePhraseWeight(text: string): number {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean).length
  const punctuation = String(text || '').match(/[.!?;:]/g)?.length || 0
  return Math.max(1.2, words * 0.45 + punctuation * 0.25)
}

/** Línea con solo el instante de inicio — lo que devuelven las letras sin sync perfecto. */
export interface PlainLine {
  time: number
  text: string
}

export function synthesizeTimingFromPlain(
  plainText: string,
  duration: number | null | undefined,
  fallbackLines: { time: number; text: string }[] = [],
): PlainLine[] {
  const rawLines = plainText.split('\n').map((l) => l.trim()).filter(Boolean)
  if (rawLines.length === 0) return []

  const fallbackAnchors = Array.isArray(fallbackLines)
    ? fallbackLines.map((line) => Number(line.time)).filter((value) => Number.isFinite(value))
    : []

  if (fallbackAnchors.length >= rawLines.length) {
    return rawLines.map((text, index) => ({
      time: fallbackAnchors[index] || index * 2,
      text,
    }))
  }

  const span = duration && duration > 0 ? duration : Math.max(rawLines.length * 4, 20)
  const weights = rawLines.map((text) => estimatePhraseWeight(text))
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0)
  let cursor = 0

  return rawLines.map((text, index) => {
    const weight = (weights[index] ?? 0) / Math.max(totalWeight, 1)
    const lineSpan = Math.max(1.2, span * weight)
    const start = cursor
    const end = Math.min(span, start + lineSpan)
    const time = start + Math.min(0.8, Math.max(0.2, lineSpan * 0.18))
    cursor = end
    return { time, text }
  })
}

async function fetchJson<T>(url: string, { signal }: { signal?: AbortSignal } = {}): Promise<T | null> {
  const res = await fetch(url, {
    signal,
    headers: {
      // El navegador no deja setear User-Agent — LRCLIB documenta estas
      // alternativas para clientes web (ver https://lrclib.net/docs).
      'Lrclib-Client': 'XFY (github.com/xfy-react)',
      'X-User-Agent': 'XFY-web/1.0',
    },
  })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`LRCLIB respondió ${res.status}`)
  return (await res.json()) as T
}

// Tolerancia "blanda": hasta acá la duración suma puntos como desempate fino.
const DURATION_TOLERANCE_S = 3
// Guardia DURA: un candidato cuya duración se desvía más que esto de la
// canción pedida es casi seguro OTRA versión (remaster distinto, live,
// sped-up, radio edit). Antes solo restaba puntos y podía ganar igual si
// el título calzaba exacto — asignándole a la canción la letra de otra.
const DURATION_HARD_LIMIT_S = 10

/**
 * Puntaje de un candidato contra la búsqueda. Expuesto para tests:
 * la regla de oro es que título+artista dominan, sync es bonus, y una
 * duración imposible descarta al candidato aunque el texto calce perfecto.
 */
export function scoreCandidate(
  r: LRCLIBRecord,
  { title, artist, duration }: { title: string; artist: string; duration?: number | null },
): number {
  const norm = (s: unknown): string => String(s || '').toLowerCase().trim()
  const titleN = norm(title)
  const artistN = norm(artist)

  let score = 0
  const rTitle = norm(r.trackName)
  const rArtist = norm(r.artistName)

  // Coincidencia de artista y título — criterio dominante
  if (rArtist === artistN) score += 20
  else if (rArtist.includes(artistN) || artistN.includes(rArtist)) score += 10

  if (rTitle === titleN) score += 20
  else if (rTitle.includes(titleN) || titleN.includes(rTitle)) score += 10

  // Tener letras sincronizadas es un bonus, pero nunca compensa mal match
  if (r.syncedLyrics) score += 5

  // Duración cercana es un desempate fino
  if (duration && r.duration) {
    const diff = Math.abs(r.duration - duration)
    if (diff > DURATION_HARD_LIMIT_S) {
      // Versión distinta de la canción: mejor sin letra que la equivocada.
      score -= 100
    } else {
      score += diff <= DURATION_TOLERANCE_S ? 5 : Math.max(0, 3 - diff / 10)
    }
  }

  if (r.instrumental) score -= 20
  return score
}

function pickBestCandidate(
  results: LRCLIBRecord[] | null,
  { title, artist, duration }: { title: string; artist: string; duration?: number | null },
): LRCLIBRecord | null {
  if (!Array.isArray(results) || results.length === 0) return null

  const scored = results.map((r) => ({ r, score: scoreCandidate(r, { title, artist, duration }) }))
  scored.sort((a, b) => b.score - a.score)

  // Umbral mínimo: al menos tiene que haber coincidido algo de artista O título.
  // Si score < 10 significa que no hubo ningún match real — preferimos no
  // devolver letras de una canción totalmente diferente. (Un guardia duro de
  // duración deja el score en negativo, así que tampoco resucita acá.)
  const best = scored[0]
  if (!best || best.score < 10) return null
  return best.r
}

async function withRetry<T>(fn: () => Promise<T>, retries = 1): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    if (retries <= 0 || (err instanceof Error && err.name === 'AbortError')) throw err
    await new Promise((resolve) => setTimeout(resolve, 600))
    return withRetry(fn, retries - 1)
  }
}

/**
 * Busca la letra en LRCLIB: match exacto por duración → búsqueda difusa →
 * título/artista limpios de ruido de YouTube. Cachea el resultado (o null)
 * en memoria + sessionStorage por canción.
 */
export async function fetchLyricsFromLRCLIB({
  title,
  artist,
  album,
  duration,
  fallbackLyrics = [],
  signal,
}: LRCLIBQuery): Promise<LRCLIBResult | null> {
  if (!title || !artist) return null

  const key = cacheKey(title, artist)
  const cached = await readLyricCache<LRCLIBResult | null>(key)
  if (cached !== undefined) return cached

  let record: LRCLIBRecord | null = null

  // 1) Match exacto por duración — el más confiable cuando la tenemos
  if (duration) {
    try {
      record = await withRetry(() =>
        fetchJson<LRCLIBRecord>(
          `${BASE_URL}/get?${new URLSearchParams({
            track_name: title,
            artist_name: artist,
            album_name: album || '',
            duration: String(Math.round(duration)),
          })}`,
          { signal },
        ),
      )
    } catch {
      record = null // seguimos al plan B, no cortamos acá
    }
  }

  // 2) Búsqueda difusa — cubre discrepancias de duración/álbum, remixes, etc.
  if (!record) {
    try {
      const results = await withRetry(() =>
        fetchJson<LRCLIBRecord[]>(
          `${BASE_URL}/search?${new URLSearchParams({ track_name: title, artist_name: artist })}`,
          { signal },
        ),
      )
      record = pickBestCandidate(results, { title, artist, duration })
    } catch {
      record = null
    }
  }

  // 3) Título/artista "limpios": si el título viene tal cual lo dejó
  // YouTube/metadata (con "(Official Video)", "- Remastered 2011",
  // "feat. X", etc.) el intento anterior puede no matchear nada porque
  // LRCLIB indexa el título real de la pista. Solo se intenta si limpiar
  // realmente cambió algo — si no, sería la misma query de nuevo.
  if (!record) {
    const cleanTitle = stripNoise(title)
    const cleanArtist = stripNoise(artist)
    if (cleanTitle && (cleanTitle !== title || cleanArtist !== artist)) {
      try {
        const results = await withRetry(() =>
          fetchJson<LRCLIBRecord[]>(
            `${BASE_URL}/search?${new URLSearchParams({ track_name: cleanTitle, artist_name: cleanArtist || artist })}`,
            { signal },
          ),
        )
        record = pickBestCandidate(results, { title: cleanTitle, artist: cleanArtist || artist, duration })
      } catch {
        record = null
      }
    }
  }

  if (!record || record.instrumental) {
    // Instrumental conocido: se cachea como resultado explícito para que
    // la UI muestre "letra instrumental" en vez de re-buscar cada vez.
    const instrumentalResult: LRCLIBResult | null = record?.instrumental
      ? { lines: [], synced: false, source: 'lrclib-instrumental', instrumental: true }
      : null
    await writeLyricCache(key, instrumentalResult)
    return instrumentalResult
  }

  let result: LRCLIBResult | null = null
  if (record.syncedLyrics) {
    const lines = parseLRC(record.syncedLyrics)
    result = lines.length > 0 ? { lines, synced: true, source: 'lrclib' } : null
  }
  if (!result && record.plainLyrics) {
    const lines = synthesizeTimingFromPlain(record.plainLyrics, duration || record.duration, fallbackLyrics)
    result = lines.length > 0 ? { lines, synced: false, source: 'lrclib-plain' } : null
  }

  await writeLyricCache(key, result)
  return result
}
