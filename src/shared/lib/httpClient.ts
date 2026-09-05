// ============================================================
// Cliente fetch() compartido para toda la capa de servicios (ytmusic,
// audiodb, wikipedia, musicbrainz, etc). Antes cada provider hacía su
// propio `fetch()` crudo: sin timeout (una función serverless que tarda
// de más deja el pedido colgado indefinidamente), sin reintentos (un 502
// o un blip de red mataban la carga entera de una sola vez) y sin
// deduplicar pedidos idénticos simultáneos (dos componentes — o el doble
// efecto de StrictMode — pidiendo lo mismo a la vez disparaban dos
// requests a la red en paralelo). Esto centraliza las tres cosas en un
// solo lugar para que cualquier provider nuevo las herede gratis.
// ============================================================

const DEFAULT_TIMEOUT_MS = 15000
const DEFAULT_RETRIES = 1
const DEFAULT_RETRY_DELAY_MS = 700
// 408/429: puede valer la pena esperar un poco y reintentar. 5xx: falla
// del lado del servidor, casi siempre transitoria. Cualquier otro 4xx
// (400, 401, 404...) es un error "real" del pedido — reintentarlo no
// cambia nada, así que no entra en esta lista.
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504])

export class HttpError extends Error {
  status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'HttpError'
    this.status = status
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isRetryable(err: unknown): boolean {
  if (err instanceof HttpError) return RETRYABLE_STATUS.has(err.status)
  if ((err as { isTimeout?: boolean } | null)?.isTimeout) return true
  // fetch() rechaza con un TypeError genérico ante fallos de red (DNS,
  // conexión rechazada, sin internet) — no hay `status` que inspeccionar.
  if (err instanceof TypeError) return true
  return false
}

async function attemptOnce(url: string, timeoutMs: number): Promise<unknown> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, { signal: controller.signal })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new HttpError(res.status, text.slice(0, 200) || `HTTP ${res.status}`)
    }
    try {
      return await res.json()
    } catch {
      throw new Error('La respuesta no es JSON válido')
    }
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      const timeoutErr = new Error(`Tiempo de espera agotado (${timeoutMs}ms) pidiendo ${url}`) as Error & {
        isTimeout: true
      }
      timeoutErr.isTimeout = true
      throw timeoutErr
    }
    throw err
  } finally {
    clearTimeout(timer)
  }
}

// Pedidos idénticos (misma URL) en vuelo al mismo tiempo comparten una
// sola promesa en vez de disparar N requests a la red.
const inFlight = new Map<string, Promise<unknown>>()

export interface FetchJsonOptions {
  timeoutMs?: number
  retries?: number
  retryDelayMs?: number
  dedupe?: boolean
}

/**
 * fetch() + parseo JSON, con timeout, reintentos con backoff exponencial
 * (más jitter, para no sincronizar reintentos de varios pedidos a la
 * vez) para fallos transitorios, y deduplicación de pedidos en vuelo.
 *
 * Los reintentos son deliberadamente pocos por default (1): estas APIs
 * externas suelen tener rate limits ajustados (MusicBrainz ~1 req/seg,
 * YT Music vía función serverless con IPs de datacenter), así que
 * insistir agresivamente empeora el problema en vez de resolverlo. La
 * idea es sobrevivir un blip puntual, no machacar un servicio caído.
 */
export function fetchJsonRobust<T = unknown>(url: string, opts: FetchJsonOptions = {}): Promise<T> {
  const {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    retries = DEFAULT_RETRIES,
    retryDelayMs = DEFAULT_RETRY_DELAY_MS,
    dedupe = true,
  } = opts

  const pending = inFlight.get(url) as Promise<T> | undefined
  if (dedupe && pending) return pending

  const run = async (): Promise<T> => {
    let lastErr: unknown
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        // eslint-disable-next-line no-await-in-loop
        return (await attemptOnce(url, timeoutMs)) as T
      } catch (err) {
        lastErr = err
        if (attempt === retries || !isRetryable(err)) throw err
        const backoff = retryDelayMs * 2 ** attempt + Math.random() * 200
        // eslint-disable-next-line no-await-in-loop
        await sleep(backoff)
      }
    }
    throw lastErr
  }

  const promise = run().finally(() => {
    if (dedupe) inFlight.delete(url)
  })
  if (dedupe) inFlight.set(url, promise)
  return promise
}
