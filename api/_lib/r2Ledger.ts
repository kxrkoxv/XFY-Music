/**
 * Ledger del total de bytes ocupados en R2 (prefijo yt-audio/).
 *
 * EL PROBLEMA QUE ESTO RESUELVE: antes, writeAudioTiered() mandaba TODO
 * audio nuevo a R2 sin mirar cuánto había ocupado, y el único freno era
 * el cron de lifecycle (api/cron/r2-lifecycle.ts), que corre cada 6
 * horas. Entre corrida y corrida, un pico de uploads podía empujar a R2
 * bien arriba del free tier durante horas antes de que el cron lo
 * notara y empezara a degradar a B2 — puramente reactivo.
 *
 * Este ledger permite un chequeo PROACTIVO en el momento mismo de
 * escribir, sin pagar el costo (en latencia y en operaciones Class A)
 * de listar el bucket entero en cada request:
 *
 *   - El cron, que de todos modos ya lista todo para decidir qué
 *     degradar, escribe acá el total EXACTO al final de cada corrida
 *     (writeLedgerTotal).
 *   - writeAudioTiered() lee ese total (getCachedTotal), cacheado en
 *     memoria del proceso por unos minutos, y si sumarle el archivo
 *     nuevo pasaría el soft cap, escribe directo a B2 en vez de R2.
 *   - Cada escritura exitosa a R2 ajusta el total cacheado en memoria
 *     de manera optimista (bumpCachedTotal), así ráfagas de uploads
 *     dentro de la misma instancia no todas leen el mismo número viejo.
 *
 * Es una aproximación, no un contador exacto: el ajuste optimista vive
 * en memoria de UNA instancia serverless (no se comparte entre
 * invocaciones concurrentes en instancias distintas) y se resetea en
 * cold start. Pero se autocorrige solo cada 6 horas cuando el cron
 * vuelve a escribir el total real — y el colchón de 1 GB entre soft
 * cap y el límite gratis (ver storageBudget.ts) está pensado
 * justamente para absorber ese margen de imprecisión.
 */
import { s3Get, s3Put, type S3TierConfig } from './s3Compat.ts'

const LEDGER_KEY = 'yt-audio/_usage/r2-total-bytes.json'
const CACHE_TTL_MS = 2 * 60 * 1000 // 2 min: suficiente para no releer en cada request de una ráfaga

interface LedgerState {
  totalBytes: number
  fetchedAt: number // cuándo se leyó/escribió ESTE valor (para el TTL de memoria)
}

let cached: LedgerState | null = null
// Evita que ráfagas concurrentes disparen múltiples GETs del ledger a
// la vez mientras el caché está frío (todas esperan la misma promesa).
let inFlight: Promise<number> | null = null

async function fetchLedgerTotal(cfg: S3TierConfig): Promise<number> {
  try {
    const buf = await s3Get(cfg, LEDGER_KEY)
    if (!buf) return 0 // sin ledger todavía (primera vez) = asumimos vacío, no bloqueamos escrituras
    const data = JSON.parse(buf.toString('utf-8')) as { totalBytes?: number }
    return typeof data.totalBytes === 'number' && data.totalBytes >= 0 ? data.totalBytes : 0
  } catch {
    return 0 // ledger corrupto o ilegible: fail-open, el cron lo va a reescribir bien en su próxima corrida
  }
}

/** Total de bytes en R2 según el último snapshot conocido (cacheado ~2 min en memoria). */
export async function getCachedTotal(cfg: S3TierConfig): Promise<number> {
  const now = Date.now()
  if (cached && now - cached.fetchedAt < CACHE_TTL_MS) return cached.totalBytes
  if (inFlight) return inFlight

  inFlight = fetchLedgerTotal(cfg).then((totalBytes) => {
    cached = { totalBytes, fetchedAt: Date.now() }
    inFlight = null
    return totalBytes
  })
  return inFlight
}

/** Ajuste optimista en memoria tras una escritura exitosa a R2 — no toca el objeto remoto. */
export function bumpCachedTotal(deltaBytes: number): void {
  if (cached) cached.totalBytes = Math.max(0, cached.totalBytes + deltaBytes)
}

/** El cron de lifecycle llama esto al final de cada corrida con el total EXACTO recién listado. */
export async function writeLedgerTotal(cfg: S3TierConfig, totalBytes: number): Promise<void> {
  cached = { totalBytes, fetchedAt: Date.now() }
  try {
    await s3Put(cfg, LEDGER_KEY, JSON.stringify({ totalBytes, updatedAt: Date.now() }), 'application/json')
  } catch (err) {
    console.warn('[r2Ledger] no se pudo persistir el total:', String(err instanceof Error ? err.message : err).slice(0, 120))
  }
}
