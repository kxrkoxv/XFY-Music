// ============================================================
// Cola de descarga con prioridad — el pegamento entre los
// proveedores de metadata (musicbrainz.js, itunes.js, audiodb.js) y
// el caché de assets (cacheManager.js).
//
// Tres prioridades:
//   'now'      — se está por reproducir ESTA canción ahora mismo.
//                 Salta al frente de la cola y corre ya.
//   'next'     — la siguiente en la cola de reproducción. Se
//                 descarga en background mientras suena la actual.
//   'prefetch' — todo lo demás (portadas visibles en pantalla, video
//                 de fondo, próximas recomendaciones). Corre cuando
//                 hay lugar libre, con concurrencia baja para no
//                 competir con lo que sí importa ahora.
//
// Dedupea por `key`: si dos partes de la UI piden el mismo asset a
// la vez, comparten la misma descarga en vez de duplicarla.
//
// Móvil (2026): la concurrencia se adapta a la calidad de red real
// (effectiveType del Network Information API) y el prefetch puro se
// SUSPENDE cuando el sistema pide ahorro de datos (saveData) o el
// usuario activó el modo ahorro propio — 'now'/'next' siguen, porque
// esos no son cortesía sino la reproducción misma.
// ============================================================

import { getCachedAssetUrl, isAssetCached } from '@shared/lib/cacheManager'

export type DownloadPriority = 'now' | 'next' | 'prefetch'
export type DownloadKind = 'audio' | 'video' | 'image'

const CONCURRENCY: Record<DownloadPriority, number> = {
  now: 2,
  next: 2,
  prefetch: 2,
}

const MAX_RETRIES = 2
const RETRY_BASE_DELAY_MS = 800

const PRIORITY_ORDER: Record<DownloadPriority, number> = { now: 0, next: 1, prefetch: 2 }

/** Progreso de una descarga activa, tal como lo consume la UI. */
export interface DownloadProgress {
  key: string
  kind: DownloadKind
  loaded: number
  /** Bytes totales declarados; null si el server responde chunked. */
  total: number | null
}

interface DownloadTask {
  key: string
  url: string
  kind: DownloadKind
  priority: DownloadPriority
  resolve: (url: string) => void
  reject: (err: Error) => void
  attempts: number
}

const queue: DownloadTask[] = []
const inFlight = new Map<string, Promise<string>>() // key -> Promise<string>
let activeCount = 0

// --- Progreso observable ---
const progressById = new Map<string, DownloadProgress>()
const progressListeners = new Set<(snapshot: DownloadProgress[]) => void>()

function publishProgress(): void {
  const snapshot = [...progressById.values()]
  progressListeners.forEach((cb) => {
    try {
      cb(snapshot)
    } catch {
      /* listener de UI */
    }
  })
}

/** Se suscribe al estado de descargas en vivo. Devuelve la desuscripción. */
export function subscribeDownloadProgress(
  cb: (snapshot: DownloadProgress[]) => void,
): () => void {
  progressListeners.add(cb)
  cb([...progressById.values()])
  return () => {
    progressListeners.delete(cb)
  }
}

// --- Cortesía de red adaptativa ---
function isSaveDataActive(): boolean {
  try {
    if (typeof navigator === 'undefined') return false
    const conn = navigator.connection as (Connection & { saveData?: boolean }) | undefined
    if (conn?.saveData) return true
    if (localStorage.getItem('xfy_data_saver') === '1') return true
    return false
  } catch {
    return false
  }
}

interface Connection {
  effectiveType?: 'slow-2g' | '2g' | '3g' | '4g'
}

function dynamicConcurrencyLimit(): number {
  let limit = CONCURRENCY.now + CONCURRENCY.next + CONCURRENCY.prefetch
  try {
    const conn = navigator.connection as (Connection & { saveData?: boolean }) | undefined
    const t = conn?.effectiveType
    if (t === 'slow-2g' || t === '2g') limit = Math.min(limit, 1)
    else if (t === '3g') limit = Math.min(limit, 2)
  } catch {
    /* sin Network Information API: límite completo */
  }
  return limit
}

function sortQueue(): void {
  queue.sort((a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority])
}

async function runTask(task: DownloadTask): Promise<void> {
  activeCount++
  progressById.set(task.key, { key: task.key, kind: task.kind, loaded: 0, total: null })
  publishProgress()
  try {
    const url = await getCachedAssetUrl(task.key, task.url, task.kind, (loaded, total) => {
      const prev = progressById.get(task.key)
      progressById.set(task.key, {
        key: task.key,
        kind: task.kind,
        loaded,
        total: total ?? prev?.total ?? null,
      })
      publishProgress()
    })
    task.resolve(url)
    inFlight.delete(task.key)
  } catch (e) {
    task.attempts += 1
    if (task.attempts <= MAX_RETRIES) {
      const delay = RETRY_BASE_DELAY_MS * 2 ** (task.attempts - 1)
      setTimeout(() => {
        queue.push(task)
        sortQueue()
        pump()
      }, delay)
    } else {
      console.warn(`[XFY] Descarga falló tras ${MAX_RETRIES} reintentos`)
      task.resolve(task.url) // último recurso: servir directo desde la red
      inFlight.delete(task.key)
    }
  } finally {
    activeCount--
    progressById.delete(task.key)
    publishProgress()
    pump()
  }
}

function pump(): void {
  const limit = dynamicConcurrencyLimit()
  const saveData = isSaveDataActive()
  while (activeCount < limit && queue.length > 0) {
    sortQueue()
    const idx = queue.findIndex((t) => !(saveData && t.priority === 'prefetch'))
    if (idx === -1) break // solo queda prefetch y hay que ahorrar datos
    const [task] = queue.splice(idx, 1)
    if (task) runTask(task)
  }
}

export interface EnqueueDownloadOptions {
  key: string
  url: string
  kind?: DownloadKind
  priority?: DownloadPriority
}

// Encola (o reutiliza) la descarga de un asset. Devuelve una URL
// reproducible/usable en cuanto está lista — local (blob:) si se pudo
// cachear, o la remota directa si falló.
export function enqueueDownload({ key, url, kind = 'audio', priority = 'prefetch' }: EnqueueDownloadOptions): Promise<string> {
  if (!url) return Promise.resolve(url)
  const pending = inFlight.get(key)
  if (pending) return pending

  const promise = new Promise<string>((resolve, reject) => {
    queue.push({ key, url, kind, priority, resolve, reject, attempts: 0 })
  })
  inFlight.set(key, promise)
  pump()
  return promise
}

// Para prefetch silencioso (no bloquea a nadie esperando el resultado,
// simplemente deja el asset cacheado para la próxima vez).
export function prefetch({ key, url, kind = 'audio' }: EnqueueDownloadOptions): void {
  if (!url) return
  isAssetCached(key).then((cached) => {
    if (!cached) enqueueDownload({ key, url, kind, priority: 'prefetch' })
  })
}

export function getQueueStats(): {
  pending: number
  active: number
  byPriority: Record<DownloadPriority, number>
} {
  return {
    pending: queue.length,
    active: activeCount,
    byPriority: {
      now: queue.filter((t) => t.priority === 'now').length,
      next: queue.filter((t) => t.priority === 'next').length,
      prefetch: queue.filter((t) => t.priority === 'prefetch').length,
    },
  }
}
