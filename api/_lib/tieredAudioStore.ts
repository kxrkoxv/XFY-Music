/**
 * Store de audio en 3 niveles, del más "pesado de tráfico" al más
 * liviano:
 *
 *   1. Cloudflare R2 — nivel HOT, default para audio NUEVO. 10 GB
 *      gratis y egress $0: lo que importa acá, porque XFY no solo
 *      guarda este audio, lo está sirviendo todo el tiempo.
 *   2. Vercel Blob    — nivel LEGACY. Deja de recibir escrituras nuevas
 *      de audio (el índice y la metadata SÍ se quedan acá, son chicos y
 *      ya están bien donde están), pero lo que ya estaba cacheado ahí
 *      antes de esta migración se sigue sirviendo normal.
 *   3. Backblaze B2   — nivel COLD. Recibe lo que el cron de R2
 *      (api/cron/r2-lifecycle.ts) va degradando por tamaño o por
 *      antigüedad, para no perder el caché en vez de borrarlo directo.
 *
 * Ningún nivel sabe de los otros dos. El cliente (ytblob.ts) prueba las
 * 3 bases públicas en orden hot→frío al buscar un audio, así que mover
 * un archivo de nivel nunca rompe un link ni exige tocar ningún índice.
 *
 * Si R2 no está configurado (faltan env vars), todo cae al comportamiento
 * viejo: escribe y lee directo de Vercel Blob, como antes de esta
 * migración — nada se rompe mientras se configuran las cuentas nuevas.
 *
 * PROTECCIÓN CONTRA CARGOS: escribir SIEMPRE a R2 y confiar en que el
 * cron de lifecycle (cada 6 horas) lo arregle después era puramente
 * reactivo — un pico de uploads podía dejar a R2 pasado del free tier
 * durante horas. Ahora writeAudioTiered() consulta el ledger de bytes
 * (r2Ledger.ts, alimentado por el propio cron) ANTES de escribir: si R2
 * ya está cerca del soft cap, el audio nuevo va directo a B2 (o a
 * Vercel Blob si B2 tampoco está configurado), sin pasar por R2 para
 * nada. Cero riesgo de que un pico empuje a R2 sobre el límite gratis
 * entre corrida y corrida del cron.
 */
import { put as vercelPut, head as vercelHead } from '@vercel/blob'
import { s3Put, s3Head, type S3TierConfig } from './s3Compat.ts'
import { getCachedTotal, bumpCachedTotal } from './r2Ledger.ts'
import { R2_SOFT_CAP_BYTES, IMMUTABLE_AUDIO_CACHE_CONTROL } from './storageBudget.ts'

export function r2Config(): S3TierConfig | null {
  const accountId = process.env.R2_ACCOUNT_ID
  const accessKeyId = process.env.R2_ACCESS_KEY_ID
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY
  const bucket = process.env.R2_BUCKET
  const publicBaseUrl = process.env.R2_PUBLIC_BASE_URL
  if (!accountId || !accessKeyId || !secretAccessKey || !bucket || !publicBaseUrl) return null
  return {
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    bucket,
    accessKeyId,
    secretAccessKey,
    region: 'auto',
    publicBaseUrl,
  }
}

export function b2Config(): S3TierConfig | null {
  const endpoint = process.env.B2_ENDPOINT
  const accessKeyId = process.env.B2_KEY_ID
  const secretAccessKey = process.env.B2_APPLICATION_KEY
  const bucket = process.env.B2_BUCKET
  const publicBaseUrl = process.env.B2_PUBLIC_BASE_URL
  if (!endpoint || !accessKeyId || !secretAccessKey || !bucket || !publicBaseUrl) return null
  // El endpoint S3-compatible de B2 trae la región en el propio host
  // (s3.<region>.backblazeb2.com) — la sacamos de ahí en vez de pedirla
  // en otra env var aparte.
  const region = /s3\.([a-z0-9-]+)\.backblazeb2\.com/.exec(endpoint)?.[1] || 'us-west-004'
  return { endpoint, bucket, accessKeyId, secretAccessKey, region, publicBaseUrl }
}

export function tieringEnabled(): boolean {
  return !!r2Config()
}

/**
 * Escribe audio NUEVO. Orden de decisión:
 *
 *   1. R2, PERO solo si el ledger dice que hay lugar bajo el soft cap
 *      (ver comentario de archivo). Si R2 no está configurado, o SÍ
 *      está configurado pero ya no hay margen, no se lo toca para nada.
 *   2. B2, si está configurado — mismo destino frío al que el cron
 *      degrada lo viejo, así que aceptar audio nuevo acá cuando R2 está
 *      lleno es coherente con el resto del diseño.
 *   3. Vercel Blob — red de seguridad final si ninguno de los dos
 *      niveles S3-compatibles está configurado o disponible.
 *
 * `buffer.length` contra el soft cap es a propósito conservador: usa el
 * tamaño exacto del archivo que se está por subir, no un estimado.
 */
export async function writeAudioTiered(pathname: string, buffer: Buffer, contentType: string): Promise<void> {
  const r2 = r2Config()
  if (r2) {
    const currentTotal = await getCachedTotal(r2)
    if (currentTotal + buffer.length <= R2_SOFT_CAP_BYTES) {
      await s3Put(r2, pathname, buffer, contentType, IMMUTABLE_AUDIO_CACHE_CONTROL)
      bumpCachedTotal(buffer.length)
      return
    }
    console.warn(
      `[tieredAudioStore] R2 cerca del soft cap (${(currentTotal / 1e9).toFixed(2)} GB) — ${pathname} va directo a un nivel más frío`,
    )
  }

  const b2 = b2Config()
  if (b2) {
    await s3Put(b2, pathname, buffer, contentType, IMMUTABLE_AUDIO_CACHE_CONTROL)
    return
  }

  await vercelPut(pathname, buffer, {
    access: 'public',
    contentType,
    addRandomSuffix: false,
    allowOverwrite: true,
    cacheControlMaxAge: 31536000,
  })
}

/**
 * ¿Existe este audio en ALGUNO de los 3 niveles? Orden hot→frío: falla
 * rápido en el caso común (audio recién subido, vive en R2).
 */
export async function audioExistsTiered(pathname: string): Promise<boolean> {
  const r2 = r2Config()
  if (r2 && (await s3Head(r2, pathname))) return true

  try {
    await vercelHead(pathname)
    return true
  } catch {
    /* no está en el nivel legacy */
  }

  const b2 = b2Config()
  if (b2 && (await s3Head(b2, pathname))) return true

  return false
}
