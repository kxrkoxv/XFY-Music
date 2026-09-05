/**
 * Identidad canónica de canción + rutas del caché de audio compartido
 * (Vercel Blob). Módulo puro a propósito — sin imports de Vite, React ni
 * Vercel — para poder usarse desde DOS lados distintos que compilan por
 * separado y deben llegar SIEMPRE al mismo resultado:
 *
 *   - Cliente (src/features/player/lib/ytblob.js): vía alias `@shared/...`,
 *     para poder LEER el índice directo del CDN del Blob (fetch público,
 *     sin pasar por la función serverless — así el segundo usuario que
 *     pide una canción ya cacheada por otro recibe el audio real
 *     directo, sin esperar un cold start de función).
 *   - Server (api/ytcache.js): vía import relativo ('../src/shared/...'),
 *     para ESCRIBIR el índice con la misma ruta que el cliente sabe leer.
 *
 * Si esta lógica se duplicara en vez de compartirse, cualquier divergencia
 * (por mínima que sea, ej. un trim distinto) rompería el matching y el
 * índice quedaría inútil sin que nada avise.
 */

/**
 * Branded types (costo runtime CERO — existen solo en el sistema de
 * tipos): un VideoId y un SongKey dejan de ser "strings cualesquiera" y
 * pasan a ser valores VALIDADOS. Mezclar un videoId con una songKey, o
 * pasar un string sin validar donde se espera un id de YouTube, pasa a
 * ser un error de compilación en todo archivo .ts del proyecto.
 */
declare const __brand: unique symbol
type Brand<T, B extends string> = T & { readonly [__brand]: B }

/** ID de YouTube: exactamente 11 caracteres [A-Za-z0-9_-]. */
export type VideoId = Brand<string, 'VideoId'>
/** Clave canónica "titulo::artista-principal" ya normalizada. */
export type SongKey = Brand<string, 'SongKey'>

const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/

/** Type guard: afina `unknown`/`string` a VideoId validando formato. */
export function isVideoId(value: unknown): value is VideoId {
  return typeof value === 'string' && VIDEO_ID_RE.test(value)
}

/** parseVideoId para bordes donde el input es desconocido (query params, bodies). */
export function parseVideoId(value: unknown): VideoId | null {
  return isVideoId(value) ? value : null
}

/** Cast de confianza para bordes donde el formato YA está garantizado por
 *  otra validación (tests, respuestas de la API que siempre traen 11 chars). */
export function asVideoId(value: string): VideoId {
  return value as VideoId
}

/** Cast de confianza para SongKeys producidas por getSongKey (nunca null). */
export function asSongKey(key: string): SongKey {
  return key as SongKey
}

export function normalizeText(value: unknown): string {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // quita acentos
    .replace(/\([^)]*\)|\[[^\]]*\]/g, ' ') // (Official Video), [Explicit]...
    .replace(/\b(feat|ft)\.?\s.*$/i, '') // corta "feat. X" / "ft. X"
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

function primaryArtistName(artist: string | null | undefined): string {
  return String(artist || '').split(',')[0] ?? ''
}

/** Clave canónica "titulo::artista-principal", o null si falta info. */
export function getSongKey(
  title: string | null | undefined,
  artist: string | null | undefined,
): SongKey | null {
  const t = normalizeText(title)
  const a = normalizeText(primaryArtistName(artist))
  if (!t || !a) return null
  return `${t}::${a}` as SongKey
}

/** Slug legible para nombres de archivo/carpeta (organización en el Blob
 *  store). No necesita ser único por sí solo — para eso está hashKey(). */
export function slugify(value: string | null | undefined, maxLen = 60): string {
  const s = normalizeText(value).replace(/\s+/g, '-')
  return s ? s.slice(0, maxLen) : '_desconocido'
}

/** FNV-1a 32-bit — no hace falta cripto acá, solo un nombre de archivo
 *  corto, estable y ASCII-safe para el índice de canciones. */
export function hashKey(key: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(36)
}

// --- Rutas dentro del Blob store (ver comentario largo en api/ytcache.js) ---
// Template literal types: las rutas son PATRONES tipados, no strings
// sueltos — `yt-audio/${VideoId}.m4a` hace imposible construir una ruta
// con un id inválido o una extensión que no exista.
export const AUDIO_PREFIX = 'yt-audio'
export const INDEX_PREFIX = 'yt-audio/_index'
export const META_PREFIX = 'yt-audio-meta'

export type AudioPath = `yt-audio/${VideoId}.${'m4a' | 'webm'}`
export type IndexPath = `yt-audio/_index/${string}.json`
export type MetaPath = `yt-audio-meta/${string}.json`

/** yt-audio/{videoId}.m4a / .webm — el audio real, tal cual ya existía. */
export function candidateAudioPaths(videoId: VideoId): [AudioPath, AudioPath] {
  return [`${AUDIO_PREFIX}/${videoId}.m4a` as AudioPath, `${AUDIO_PREFIX}/${videoId}.webm` as AudioPath]
}

/** yt-audio/_index/{slug}-{hash}.json — "esta canción ya está cacheada
 *  bajo este videoId". Misma ruta calculada en cliente y server. */
export function indexPathFor(songKey: SongKey): IndexPath {
  return `${INDEX_PREFIX}/${slugify(songKey, 40)}-${hashKey(songKey)}.json` as IndexPath
}

/** yt-audio-meta/{artista}/{videoId}.json — metadata legible, solo para
 *  poder navegar lo cacheado agrupado por artista. */
export function metaPathFor(videoId: VideoId, artist: string): MetaPath {
  return `${META_PREFIX}/${slugify(artist)}/${videoId}.json` as MetaPath
}

/** yt-audio-meta/_by-video/{videoId}.json — la MISMA metadata que
 *  metaPathFor, pero indexada solo por videoId (sin depender de saber el
 *  artista de antemano). Existe para que /api/ytaudit.js pueda leer la
 *  duración de referencia de un archivo cacheado con un único fetch
 *  directo, en vez de tener que enumerar yt-audio-meta/ entero. */
export function metaIndexPathFor(videoId: VideoId): MetaPath {
  return `${META_PREFIX}/_by-video/${videoId}.json` as MetaPath
}
