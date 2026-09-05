// ============================================================
// Caché inteligente de XFY
// ------------------------------------------------------------
// Dos capas:
//
// 1. Assets binarios remotos (video de fondo, portadas en alta
//    resolución): se guarda el blob real en
//    la Cache Storage API bajo un cupo fijo (ASSET_CACHE_QUOTA_BYTES,
//    compartido entre todos los tipos). Cuando se supera el cupo se
//    borra lo menos usado recientemente (LRU) hasta volver a estar
//    bajo el límite. Así no se vuelve a descargar nada ya visto,
//    pero tampoco crece sin límite el almacenamiento del navegador.
//    Este módulo es el que usa downloadQueue.js para servir los
//    assets ya cacheados o encolar su descarga.
//
// 2. Metadatos (portadas de iTunes, info de AudioDB, letras de
//    LRCLIB, discografías de
//    MusicBrainz): ya vivían como pequeños cachés en localStorage con
//    su propio TTL (ver itunes.js/audiodb.js/spicyLyrics/lrclib.js/
//    providers/musicbrainz.js). Este módulo solo los agrupa para poder mostrar
//    su tamaño y vaciarlos desde Configuración.
// ============================================================

const ASSET_CACHE_NAME = 'xfy-asset-cache-v1'
const ASSET_INDEX_KEY = 'xfy_asset_cache_index_v1'
export const ASSET_CACHE_QUOTA_BYTES = 500 * 1024 * 1024 // 500 MB — audio externo y portadas (para videos LOCALES ver más abajo)

const METADATA_CACHE_KEYS = [
  { key: 'xfy_itunes_artwork_cache_v1', label: 'Portadas (iTunes)' },
  { key: 'xfy_audiodb_cache_v2', label: 'Info de artistas (AudioDB)' },
  { key: 'xfy_lrclib_cache_v1', label: 'Letras (LRCLIB)' },
  { key: 'xfy_musicbrainz_cache_v2', label: 'Discografías (MusicBrainz)' },
]

export type AssetKind = 'audio' | 'video' | 'image'

export interface AssetIndexEntry {
  size: number
  lastAccessed: number
  remoteUrl: string
  kind: AssetKind
  plays?: number
}

export type AssetIndex = Record<string, AssetIndexEntry>

export interface LocalVideoIndexEntry {
  size: number
  lastAccessed: number
  name?: string | null
  songId?: string | number
}

export type LocalVideoIndex = Record<string, LocalVideoIndexEntry>

export interface AssetCacheStats {
  count: number
  totalBytes: number
  quotaBytes: number
}

function supportsCacheStorage(): boolean {
  return typeof window !== 'undefined' && 'caches' in window
}

// ============================================================
// Storage persistente — sin esto, Chrome/Firefox pueden desalojar TODO
// el origen (Cache Storage incluido) bajo presión de espacio, y Safari
// además lo hace tras 7 días sin interacción — en ambos casos el audio
// que "ya se había cacheado" desaparece solo, sin ningún error visible
// para nosotros. navigator.storage.persist() pide quedar afuera de ese
// desalojo automático. Es best-effort (el browser decide si lo concede
// según señales de engagement) y no bloquea nada si falla o no existe.
// ============================================================
let persistRequested = false
export function requestPersistentStorage() {
  if (persistRequested) return
  persistRequested = true
  try {
    if (navigator?.storage?.persist) {
      navigator.storage.persist().catch(() => {})
    }
  } catch {
    // no crítico
  }
}

function readAssetIndex(): AssetIndex {
  try {
    const raw = localStorage.getItem(ASSET_INDEX_KEY)
    return raw ? JSON.parse(raw) : {}
  } catch {
    return {}
  }
}

function writeAssetIndex(index: AssetIndex): void {
  try {
    localStorage.setItem(ASSET_INDEX_KEY, JSON.stringify(index))
  } catch {
    // localStorage lleno: no es crítico, solo perdemos la estadística de uso
  }
}

// ============================================================
// Eviction con "heat" (estilo Smart Downloads de YT Music / LRU de
// Spotify): no es LRU puro. Cada play acumula `plays` y eso compra
// recencia virtual — una canción escuchada seguido sobrevive al cupo
// aunque haga días no suena, igual que el Offline Mixtape retiene lo
// que el usuario claramente prefiere. Encima, entradas con más de
// HARD_AGE_MS sin ser tocadas son candidatas prioritarias (regla
// "auto-remove not played in 30+ days if storage is low" de Spotify).
// ============================================================
const PLAY_RECENCY_BONUS_MS = 24 * 60 * 60 * 1000 // cada play ≈ 1 día extra de recencia
const MAX_PLAY_BONUS = 10 // tope: 10 plays ya compran el máximo
const HARD_AGE_MS = 45 * 24 * 60 * 60 * 1000 // 45 días sin tocar → primer candidato

function effectiveRecency(entry: AssetIndexEntry): number {
  return (entry.lastAccessed || 0) + Math.min(entry.plays || 0, MAX_PLAY_BONUS) * PLAY_RECENCY_BONUS_MS
}

async function evictLeastRecentlyUsed(cache: Cache, index: AssetIndex, quotaBytes = ASSET_CACHE_QUOTA_BYTES): Promise<AssetIndex> {
  let total = Object.values(index).reduce((sum, entry) => sum + (entry.size || 0), 0)
  if (total <= quotaBytes) return index

  const now = Date.now()
  const entries = Object.entries(index)
  const agedOut = entries
    .filter(([, e]) => now - (e.lastAccessed || 0) > HARD_AGE_MS)
    .sort((a, b) => (a[1].lastAccessed || 0) - (b[1].lastAccessed || 0))
  const rest = entries
    .filter(([, e]) => now - (e.lastAccessed || 0) <= HARD_AGE_MS)
    .sort((a, b) => effectiveRecency(a[1]) - effectiveRecency(b[1]))

  for (const [cacheKey, entry] of [...agedOut, ...rest]) {
    if (total <= quotaBytes) break
    await cache.delete(new Request(cacheKey))
    total -= entry.size || 0
    delete index[cacheKey]
  }
  return index
}

// ============================================================
// Poda por edad, INDEPENDIENTE del cupo — evictLeastRecentlyUsed de
// arriba solo actúa cuando `total > quotaBytes`, así que si el usuario
// nunca llena los 500MB, una canción que se cacheó una vez y no volvió a
// sonar en meses se queda ahí para siempre (el "candidato prioritario"
// de HARD_AGE_MS nunca llegaba a ejecutarse porque nada disparaba el
// desalojo). Esta función corre SIEMPRE (llamada periódica desde App.jsx,
// no atada a cache.put) y borra sin condición cualquier entrada que
// lleve más de HARD_AGE_MS sin reproducirse — "se borran solas las que
// tienen más tiempo sin sonar", esté lleno el storage o no.
// ============================================================
export async function pruneAgedAssets(maxAgeMs: number = HARD_AGE_MS): Promise<number> {
  if (!supportsCacheStorage()) return 0
  try {
    const cache = await caches.open(ASSET_CACHE_NAME)
    const index = readAssetIndex()
    const now = Date.now()
    let removed = 0
    for (const [cacheKey, entry] of Object.entries(index)) {
      if (now - (entry.lastAccessed || 0) <= maxAgeMs) continue
      await cache.delete(new Request(cacheKey))
      delete index[cacheKey]
      removed += 1
    }
    if (removed > 0) writeAssetIndex(index)
    return removed
  } catch {
    // no crítico: si falla, la próxima corrida (24hs después) lo vuelve a intentar
    return 0
  }
}

// Desalojo de emergencia: se dispara cuando cache.put() ya tiró
// QuotaExceededError, es decir cuando el cupo REAL del dispositivo
// (a veces muchísimo más chico que ASSET_CACHE_QUOTA_BYTES — Safari/iOS
// históricamente cortaba en 50MB por partición) ya se llenó antes de que
// nuestro cupo "blando" se diera cuenta. Acá no alcanza con desalojar lo
// justo para volver a nuestro límite (ese cálculo asume que el límite
// real es el nuestro); se libera una fracción del índice completo para
// dejar margen real y no repetir el error en cada canción nueva.
async function evictEmergency(cache: Cache, index: AssetIndex, fraction = 0.4): Promise<AssetIndex> {
  const entries = Object.entries(index).sort((a, b) => effectiveRecency(a[1]) - effectiveRecency(b[1]))
  const toRemove = Math.max(1, Math.ceil(entries.length * fraction))
  for (let i = 0; i < toRemove && i < entries.length; i++) {
    const entry = entries[i]
    if (!entry) continue
    const [cacheKey] = entry
    await cache.delete(new Request(cacheKey))
    delete index[cacheKey]
  }
  return index
}

/**
 * Marca calor de reproducción sobre un asset de audio ya cacheado.
 * Fire-and-forget: si la entrada todavía no existe (la descarga en background
 * sigue en curso), es un noop — el próximo play la sube.
 */
export function touchAssetPlay(cacheKey: string): void {
  const index = readAssetIndex()
  if (!index[cacheKey]) return
  index[cacheKey].plays = (index[cacheKey].plays || 0) + 1
  index[cacheKey].lastAccessed = Date.now()
  writeAssetIndex(index)
}

// Pedidos en vuelo por cacheKey — si dos componentes piden el mismo asset
// al mismo tiempo (típico: varias tarjetas mostrando el mismo avatar de
// artista) antes de que el primero termine de guardarlo en caché, sin esto
// cada uno dispara su propio fetch por separado. Con muchas tarjetas
// pidiendo la misma imagen a la vez eso es exactamente lo que dispara un
// 429 (demasiados pedidos) del lado del proveedor. Con este mapa, el
// segundo pedido (y el tercero, y el décimo) simplemente esperan la MISMA
// promesa que ya está en curso en vez de arrancar la suya.
const inFlight = new Map<string, Promise<string>>()

// Devuelve una URL usable para `remoteUrl` (audio, video o imagen),
// sirviéndola desde caché si ya se descargó antes. `cacheKey` debe ser
// estable por asset (ej. "xfy-track-42") para que distintos
// assets no choquen entre sí. `kind` es solo informativo (se guarda en
// el índice, útil para mostrar estadísticas separadas por tipo en
// Configuración) — el cupo y el LRU son compartidos entre todos.
//
// `onProgress`, si viene, reporta bytes descargados en vivo
// (loaded, total — total puede ser null si el server no manda
// Content-Length) mientras el archivo entra al caché.
export async function getCachedAssetUrl(
  cacheKey: string,
  remoteUrl: string,
  kind: AssetKind = 'audio',
  onProgress?: DownloadProgressCallback,
): Promise<string> {
  if (!remoteUrl) return remoteUrl
  // data:/blob: ya son locales (p. ej. portadas de playlist subidas por el
  // usuario) — la Cache Storage API no acepta requests con esos esquemas,
  // así que se devuelven tal cual sin pasar por fetch/cache.
  if (remoteUrl.startsWith('data:') || remoteUrl.startsWith('blob:')) return remoteUrl
  if (!supportsCacheStorage()) return remoteUrl

  const existing = inFlight.get(cacheKey)
  if (existing) return existing

  const task = fetchAndCache(cacheKey, remoteUrl, kind, onProgress).finally(() => {
    inFlight.delete(cacheKey)
  })
  inFlight.set(cacheKey, task)
  return task
}

/** Progreso de una descarga: bytes recibidos y total declarado (null = chunked). */
export type DownloadProgressCallback = (loaded: number, total: number | null) => void

/**
 * Lee el body de un response EN STREAMING acumulando chunks — lo que hace
 * posible progreso real de descarga sin duplicar memoria (los Uint8Array
 * del stream son transferibles al Blob final). Si el navegador no expone
 * body legible o no hay Content-Length, `total` va en null y la UI muestra
 * progreso indeterminado.
 */
async function readResponseWithProgress(
  fetched: Response,
  onProgress: DownloadProgressCallback,
): Promise<Blob> {
  const totalHeader = fetched.headers.get('content-length')
  const total = totalHeader ? Number(totalHeader) : null
  const reader = fetched.body?.getReader()
  if (!reader) return fetched.blob()

  const chunks: BlobPart[] = []
  let loaded = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue
    chunks.push(value.slice().buffer as ArrayBuffer)
    loaded += value.byteLength
    try {
      onProgress(loaded, total)
    } catch {
      /* callback de UI: jamás debe romper la descarga */
    }
  }
  return new Blob(chunks, { type: fetched.headers.get('content-type') ?? 'application/octet-stream' })
}

async function fetchAndCache(
  cacheKey: string,
  remoteUrl: string,
  kind: AssetKind,
  onProgress?: DownloadProgressCallback,
): Promise<string> {
  try {
    const cache = await caches.open(ASSET_CACHE_NAME)
    const request = new Request(cacheKey)
    let response = await cache.match(request)
    const index = readAssetIndex()

    if (!response) {
      const fetched = await fetch(remoteUrl)
      if (!fetched.ok) return remoteUrl
      // Un solo read del body (antes se leía dos veces vía clone(): una
      // para cache.put y otra para medir el tamaño). Con el blob ya en
      // mano armamos la Response que se guarda Y la que se sirve.
      const blob = onProgress ? await readResponseWithProgress(fetched, onProgress) : await fetched.blob()
      try {
        await cache.put(request, new Response(blob, { headers: fetched.headers }))
      } catch (putErr) {
        // QuotaExceededError: el cupo REAL del dispositivo ya se llenó
        // (puede ser mucho menor a ASSET_CACHE_QUOTA_BYTES — ver
        // evictEmergency). Sin este catch, cache.put fallaba silenciosamente
        // hacia el catch de afuera y la pista NUNCA quedaba cacheada, por
        // más reintentos que hubiera — el síntoma exacto de "no se cachea".
        console.warn('[XFY] Almacenamiento lleno, liberando espacio')
        await evictEmergency(cache, index)
        writeAssetIndex(index)
        await cache.put(request, new Response(blob, { headers: fetched.headers }))
      }
      index[cacheKey] = { size: blob.size, lastAccessed: Date.now(), remoteUrl, kind }
      const cleanedIndex = await evictLeastRecentlyUsed(cache, index)
      writeAssetIndex(cleanedIndex)
      if (!cleanedIndex[cacheKey]) return remoteUrl
      return URL.createObjectURL(blob)
    }

    index[cacheKey] = { ...(index[cacheKey] || { size: 0 }), lastAccessed: Date.now(), remoteUrl, kind }
    const cleanedIndex = await evictLeastRecentlyUsed(cache, index)
    writeAssetIndex(cleanedIndex)
    if (!cleanedIndex[cacheKey]) return remoteUrl

    const blob = await response.blob()
    return URL.createObjectURL(blob)
  } catch (e) {
    console.warn('[XFY] Caché no disponible, sirviendo directo')
    return remoteUrl
  }
}

// Camino rápido para el arranque de reproducción: UNA sola apertura de
// Cache Storage que responde "ya está" o "no está" y de paso trae la
// blob URL, en vez de que el caller haga isAssetCached() + getCachedAssetUrl()
// por separado (dos aperturas + dos cache.match secuenciales sobre el MISMO
// key, pura latencia de IO duplicada justo en el momento en que más importa
// que la respuesta sea instantánea).
export async function getCachedAssetIfPresent(cacheKey: string): Promise<string | null> {
  if (!supportsCacheStorage()) return null
  try {
    const cache = await caches.open(ASSET_CACHE_NAME)
    const response = await cache.match(new Request(cacheKey))
    if (!response) return null
    const index = readAssetIndex()
    if (index[cacheKey]) {
      index[cacheKey].lastAccessed = Date.now()
      writeAssetIndex(index)
    }
    const blob = await response.blob()
    return URL.createObjectURL(blob)
  } catch {
    return null
  }
}

// Alias por compatibilidad — el código existente que reproduce audio
// externo sigue funcionando igual sin tocar nada.
export function getCachedAudioUrl(cacheKey: string, remoteUrl: string): Promise<string> {
  return getCachedAssetUrl(cacheKey, remoteUrl, 'audio')
}

// Consulta si un asset ya está cacheado, sin descargarlo — lo usa
// downloadQueue.js para no encolar de nuevo algo que ya está local.
export async function isAssetCached(cacheKey: string): Promise<boolean> {
  if (!supportsCacheStorage()) return false
  try {
    const cache = await caches.open(ASSET_CACHE_NAME)
    const match = await cache.match(new Request(cacheKey))
    return !!match
  } catch {
    return false
  }
}

export function getAssetCacheStats(): AssetCacheStats {
  const index = readAssetIndex()
  const entries = Object.values(index)
  return {
    count: entries.length,
    totalBytes: entries.reduce((sum, e) => sum + (e.size || 0), 0),
    quotaBytes: ASSET_CACHE_QUOTA_BYTES,
  }
}

export async function clearAssetCache(): Promise<void> {
  if (supportsCacheStorage()) {
    try {
      await caches.delete(ASSET_CACHE_NAME)
    } catch {
      // nada que hacer si el navegador lo bloquea
    }
  }
  writeAssetIndex({})
}

export function getMetadataCacheStats(): { key: string; label: string; count: number; bytes: number }[] {
  return METADATA_CACHE_KEYS.map(({ key, label }) => {
    try {
      const raw = localStorage.getItem(key)
      if (!raw) return { key, label, count: 0, bytes: 0 }
      const parsed = JSON.parse(raw)
      return { key, label, count: Object.keys(parsed).length, bytes: raw.length }
    } catch {
      return { key, label, count: 0, bytes: 0 }
    }
  })
}

export function clearMetadataCache(): void {
  for (const { key } of METADATA_CACHE_KEYS) {
    try {
      localStorage.removeItem(key)
    } catch {
      // no crítico
    }
  }
}

export function formatBytes(bytes: number): string {
  if (!bytes) return '0 MB'
  const mb = bytes / (1024 * 1024)
  if (mb < 1) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`
}

// ============================================================
// Videos de fondo locales
// ------------------------------------------------------------
// A diferencia de todo lo demás en este archivo, estos archivos NO
// tienen una URL remota de la que volver a descargarse: son videos
// propios que el usuario elige desde su disco (ver el <input
// type="file"> en PlayerPage) para que se reproduzcan en loop detrás
// del reproductor de esa canción puntual, como tenía la versión
// vanilla. Por eso viven en su PROPIO bucket de Cache Storage
// separado del de assets remotos (xfy-asset-cache-v1): si compartieran
// cupo y LRU con las portadas/audio cacheados, un video local recién
// subido podría desalojarse a sí mismo o desalojar caché que sí puede
// volver a descargarse gratis — acá el costo de perder una entrada es
// mucho más alto (no hay de dónde volver a traerla), así que se separa
// con su propio cupo, más chico, y se guarda el blob directo con
// cache.put(request, new Response(file)) en vez de fetch().
const LOCAL_VIDEO_CACHE_NAME = 'xfy-local-video-bg-v1'
const LOCAL_VIDEO_INDEX_KEY = 'xfy_local_video_bg_index_v1'
export const LOCAL_VIDEO_QUOTA_BYTES = 300 * 1024 * 1024 // 300 MB

function readLocalVideoIndex(): Record<string, LocalVideoIndexEntry> {
  try {
    const raw = localStorage.getItem(LOCAL_VIDEO_INDEX_KEY)
    return raw ? JSON.parse(raw) : {}
  } catch {
    return {}
  }
}

function writeLocalVideoIndex(index: Record<string, LocalVideoIndexEntry>): void {
  try {
    localStorage.setItem(LOCAL_VIDEO_INDEX_KEY, JSON.stringify(index))
  } catch {
    // no crítico
  }
}

function localVideoKeyFor(songId: string | number): string {
  return `xfy-local-video:${songId}`
}

async function evictLocalVideoLRU(cache: Cache, index: Record<string, LocalVideoIndexEntry>): Promise<Record<string, LocalVideoIndexEntry>> {
  let total = Object.values(index).reduce((sum, entry) => sum + (entry.size || 0), 0)
  if (total <= LOCAL_VIDEO_QUOTA_BYTES) return index

  const entries = Object.entries(index).sort((a, b) => a[1].lastAccessed - b[1].lastAccessed)
  for (const [cacheKey, entry] of entries) {
    if (total <= LOCAL_VIDEO_QUOTA_BYTES) break
    await cache.delete(new Request(cacheKey))
    total -= entry.size || 0
    delete index[cacheKey]
  }
  return index
}

// Guarda `file` (de un <input type="file" accept="video/*">) como el
// video de fondo de `songId`. Si ya había uno para esa canción, lo
// reemplaza. Devuelve false si Cache Storage no está disponible o el
// archivo no es un video — en ese caso PlayerPage avisa por toast.
export async function setLocalVideoBg(songId: string | number, file: File): Promise<boolean> {
  if (!songId || !file || !supportsCacheStorage()) return false
  if (file.type && !file.type.startsWith('video/')) return false

  try {
    const cache = await caches.open(LOCAL_VIDEO_CACHE_NAME)
    const cacheKey = localVideoKeyFor(songId)
    await cache.put(new Request(cacheKey), new Response(file))

    const index = readLocalVideoIndex()
    index[cacheKey] = {
      size: file.size,
      lastAccessed: Date.now(),
      name: file.name || null,
      songId,
    }
    const cleaned = await evictLocalVideoLRU(cache, index)
    writeLocalVideoIndex(cleaned)
    // Si se desalojó a sí mismo (archivo más grande que el cupo entero),
    // avisamos que no quedó guardado en vez de mentir con un true.
    return !!cleaned[cacheKey]
  } catch (e) {
    console.warn('[XFY] No se pudo guardar el video de fondo')
    return false
  }
}

// Devuelve una object URL reproducible para el video de fondo de
// `songId`, o null si no tiene uno guardado.
export async function getLocalVideoBgUrl(songId: string | number): Promise<string | null> {
  if (!songId || !supportsCacheStorage()) return null
  try {
    const cache = await caches.open(LOCAL_VIDEO_CACHE_NAME)
    const cacheKey = localVideoKeyFor(songId)
    const response = await cache.match(new Request(cacheKey))
    if (!response) return null

    const index = readLocalVideoIndex()
    if (index[cacheKey]) {
      index[cacheKey].lastAccessed = Date.now()
      writeLocalVideoIndex(index)
    }

    const blob = await response.blob()
    return URL.createObjectURL(blob)
  } catch {
    return null
  }
}

// Chequeo liviano (sin traer el blob) para pintar el estado del botón
// "video de fondo" en PlayerPage apenas cambia de canción.
export async function hasLocalVideoBg(songId: string | number): Promise<boolean> {
  if (!songId || !supportsCacheStorage()) return false
  try {
    const cache = await caches.open(LOCAL_VIDEO_CACHE_NAME)
    const response = await cache.match(new Request(localVideoKeyFor(songId)))
    return !!response
  } catch {
    return false
  }
}

export async function removeLocalVideoBg(songId: string | number): Promise<void> {
  if (!songId || !supportsCacheStorage()) return
  try {
    const cache = await caches.open(LOCAL_VIDEO_CACHE_NAME)
    const cacheKey = localVideoKeyFor(songId)
    await cache.delete(new Request(cacheKey))
    const index = readLocalVideoIndex()
    delete index[cacheKey]
    writeLocalVideoIndex(index)
  } catch {
    // no crítico
  }
}

export function getLocalVideoBgStats(): AssetCacheStats {
  const index = readLocalVideoIndex()
  const entries = Object.values(index)
  return {
    count: entries.length,
    totalBytes: entries.reduce((sum, e) => sum + (e.size || 0), 0),
    quotaBytes: LOCAL_VIDEO_QUOTA_BYTES,
  }
}

export async function clearLocalVideoBg(): Promise<void> {
  if (supportsCacheStorage()) {
    try {
      await caches.delete(LOCAL_VIDEO_CACHE_NAME)
    } catch {
      // no crítico
    }
  }
  writeLocalVideoIndex({})
}
