/**
 * Cron: ciclo de vida del audio en el nivel HOT (Cloudflare R2).
 *
 * En vez de borrar directo al llenarse (como hacía la eviction vieja de
 * Vercel Blob en el camino de cron de ytaudit.ts), esto DEGRADA lo excedente/viejo al
 * nivel COLD (Backblaze B2) — el caché no se pierde, solo baja de nivel.
 * El cliente (ytblob.ts) ya prueba las 3 bases en orden hot→frío, así que
 * mover un archivo de R2 a B2 nunca rompe un link ni pide tocar índices.
 *
 * Dispara la democión por CUALQUIERA de los dos motivos (lo que pase
 * primero — "ambas" cubre mejor los dos escenarios reales):
 *   - TAMAÑO: el total de R2 pasa el soft cap (cerca del límite gratis
 *     de 10 GB) → baja lo más viejo hasta volver al target.
 *   - ANTIGÜEDAD: un audio no se revalida (uploadedAt) hace más de
 *     COLD_AFTER_MS, aunque R2 todavía tenga lugar de sobra — así el
 *     catálogo que nadie pide hace semanas no espera a que el store se
 *     llene para bajar de nivel, y R2 queda siempre con lo que de
 *     verdad se está reproduciendo.
 *
 * Nivel COLD con techo propio: si B2 también se llena (no hay un cuarto
 * nivel), ahí sí se borra definitivo lo más viejo — mismo patrón que la
 * eviction vieja, aplicado un escalón más abajo.
 *
 * Si B2 todavía no está configurado, este cron igual corre y REPORTA el
 * total de R2 (útil para decidir cuándo hace falta configurarlo), pero
 * no mueve ni borra nada — nunca destruye caché por no tener a dónde
 * mandarlo.
 *
 * Al final de cada corrida, esto además persiste el total EXACTO de R2
 * en el ledger (r2Ledger.ts) — es lo que le permite a writeAudioTiered()
 * decidir PROACTIVAMENTE, en el momento de subir un audio nuevo, si hay
 * lugar en R2 sin tener que listar el bucket entero en cada request.
 */
import type { VercelRequest, VercelResponse } from '@vercel/node'
import { r2Config, b2Config } from '../_lib/tieredAudioStore.ts'
import { s3List, s3Get, s3Put, s3Delete, type S3TierConfig, type S3ListItem } from '../_lib/s3Compat.ts'
import { writeLedgerTotal } from '../_lib/r2Ledger.ts'
import { R2_SOFT_CAP_BYTES, R2_TARGET_BYTES, B2_HARD_CAP_BYTES, B2_TARGET_BYTES, COLD_AFTER_MS, IMMUTABLE_AUDIO_CACHE_CONTROL } from '../_lib/storageBudget.ts'

export const config = { maxDuration: 300 }

const PREFIX = 'yt-audio/'
const AUDIO_RE = /^yt-audio\/([A-Za-z0-9_-]{11})\.(m4a|webm)$/

const MAX_OPS_PER_RUN = 60 // techo de movimientos/borrados por corrida
const TIME_BUDGET_MS = 280 * 1000

async function listAllAudio(cfg: S3TierConfig): Promise<(S3ListItem & { ext: string })[]> {
  const items: (S3ListItem & { ext: string })[] = []
  let token: string | undefined
  do {
    const page = await s3List(cfg, PREFIX, token)
    for (const it of page.items) {
      const m = AUDIO_RE.exec(it.key)
      if (m) items.push({ ...it, ext: m[2]! })
    }
    token = page.nextToken
  } while (token && items.length < 20000)
  return items
}

function mimeFor(ext: string): string {
  return ext === 'webm' ? 'audio/webm' : 'audio/mp4'
}

async function moveObject(from: S3TierConfig, to: S3TierConfig, key: string, ext: string): Promise<boolean> {
  const buf = await s3Get(from, key)
  if (!buf) return false
  // El audio sigue siendo inmutable en el nivel frío — mismo header que
  // en la escritura original, para que B2 también se pueda servir desde
  // cache en vez de contar como transacción de lectura contra su cuota.
  await s3Put(to, key, buf, mimeFor(ext), IMMUTABLE_AUDIO_CACHE_CONTROL)
  await s3Delete(from, key)
  return true
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<VercelResponse> {
  const isVercelCron = req.headers['x-vercel-cron'] === '1'
  const cronSecret = process.env.CRON_SECRET
  const hasValidSecret = cronSecret && req.headers['authorization'] === `Bearer ${cronSecret}`
  if (!isVercelCron && !hasValidSecret) {
    return res.status(401).json({ error: 'solo Vercel Cron puede disparar esto' })
  }

  const r2 = r2Config()
  if (!r2) return res.status(503).json({ error: 'R2 no configurado todavía' })
  const b2 = b2Config() // null = sin B2: este cron solo reporta, no mueve nada

  const startedAt = Date.now()
  const timeLeft = () => TIME_BUDGET_MS - (Date.now() - startedAt)
  const now = Date.now()

  const r2Audio = await listAllAudio(r2)
  const r2Total = r2Audio.reduce((sum, it) => sum + it.size, 0)

  let movedToB2 = 0
  let bytesMovedToB2 = 0

  if (b2) {
    const byAge = [...r2Audio].sort((a, b) => a.uploadedAt - b.uploadedAt)
    let runningTotal = r2Total
    for (const item of byAge) {
      if (movedToB2 >= MAX_OPS_PER_RUN || timeLeft() < 20 * 1000) break
      const isCold = now - item.uploadedAt > COLD_AFTER_MS
      const overCap = runningTotal > R2_SOFT_CAP_BYTES && runningTotal > R2_TARGET_BYTES
      if (!isCold && !overCap) continue
      try {
        const moved = await moveObject(r2, b2, item.key, item.ext)
        if (moved) {
          runningTotal -= item.size
          movedToB2++
          bytesMovedToB2 += item.size
        }
      } catch (err) {
        console.warn('[cron/r2-lifecycle] no se pudo mover', item.key, String(err instanceof Error ? err.message : err).slice(0, 120))
      }
    }
  }

  // Techo del nivel COLD: sin cuarto nivel adonde bajar, si B2 se llena
  // se borra definitivo lo más viejo — igual que hacía la eviction vieja,
  // un escalón más abajo en la cadena.
  let evictedFromB2 = 0
  let bytesEvictedFromB2 = 0
  if (b2) {
    const b2Audio = await listAllAudio(b2)
    let b2Total = b2Audio.reduce((sum, it) => sum + it.size, 0)
    if (b2Total > B2_HARD_CAP_BYTES) {
      const byAge = [...b2Audio].sort((a, b) => a.uploadedAt - b.uploadedAt)
      for (const item of byAge) {
        if (b2Total <= B2_TARGET_BYTES || evictedFromB2 >= MAX_OPS_PER_RUN || timeLeft() < 10 * 1000) break
        await s3Delete(b2, item.key)
        b2Total -= item.size
        evictedFromB2++
        bytesEvictedFromB2 += item.size
      }
    }
  }

  // Total final post-degradación — esto es lo que va a leer
  // writeAudioTiered() (vía r2Ledger.getCachedTotal) hasta la próxima
  // corrida, para decidir sin listar el bucket si hay lugar en R2.
  const r2FinalTotal = r2Total - bytesMovedToB2
  await writeLedgerTotal(r2, r2FinalTotal)

  const result = {
    r2Total: r2FinalTotal,
    r2Count: r2Audio.length - movedToB2,
    b2Configured: !!b2,
    movedToB2,
    bytesMovedToB2,
    evictedFromB2,
    bytesEvictedFromB2,
  }
  console.log('[cron/r2-lifecycle]', JSON.stringify(result))
  return res.status(200).json(result)
}
