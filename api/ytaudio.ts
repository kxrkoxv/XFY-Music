/**
 * Serverless Function: resuelve audio directo de YouTube/YT Music.
 *
 * Delegada 100% en api/_lib/ytcore.js (youtubei.js + PO tokens BotGuard —
 * ver el comentario ahí para el porqué de cada pieza). El contrato con el
 * frontend es el mismo que antes: { url, mimeType }, más `proxiedUrl`
 * apuntando a /api/ytstream por si la URL directa falla en el navegador
 * (googlevideo ata la firma a la IP que la generó; si Vercel la mintió,
 * a veces el browser recibe 403 y ahí entra el proxy).
 *
 * GET /api/ytaudio?videoId=XXX → { url, proxiedUrl, mimeType, bitrate, durationSecs }
 */

import type { VercelRequest, VercelResponse } from '@vercel/node'
import { resolveAudioUrl, getLastFailureReason } from './_lib/ytcore.ts'
import { checkRateLimit, clientIp } from './_lib/rateLimit.ts'

export const config = { maxDuration: 30 }

// MEJORA: se llama una vez por canción resuelta (no por cada chunk de
// streaming, eso es ytstream.ts) — 90 resoluciones / 5 min por IP cubre de
// sobra a alguien escuchando música real y frena scripts que solo quieren
// quemar la resolución Innertube/BotGuard, que es cara.
const YTAUDIO_LIMIT = { max: 90, windowMs: 5 * 60 * 1000 }

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<VercelResponse> {
  const limit = await checkRateLimit(`ytaudio:${clientIp(req)}`, YTAUDIO_LIMIT.max, YTAUDIO_LIMIT.windowMs)
  if (!limit.allowed) {
    res.setHeader('Retry-After', String(limit.retryAfterSeconds))
    return res.status(429).json({ error: 'Demasiadas solicitudes, esperá un poco' })
  }

  const videoId = String(req.query?.videoId || '').trim()
  if (!videoId || !/^[A-Za-z0-9_-]{11}$/.test(videoId)) {
    return res.status(400).json({ error: 'videoId inválido o faltante' })
  }

  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET')

  try {
    const resolved = await resolveAudioUrl(videoId)
    if (!resolved) {
      // `detail` expone el motivo exacto (playability, challenge anti-bot,
      // sonda, etc.) para diagnosticar sin entrar a los logs de Vercel.
      return res.status(404).json({ error: 'No se pudo extraer audio para este video', detail: getLastFailureReason() })
    }
    return res.status(200).json({
      url: resolved.url,
      proxiedUrl: `/api/ytstream?videoId=${encodeURIComponent(videoId)}`,
      mimeType: resolved.mimeType,
      bitrate: resolved.bitrate,
      durationSecs: resolved.durationSecs,
    })
  } catch (err) {
    console.warn('[ytaudio] Error inesperado:', String(err instanceof Error ? err.message : err).slice(0, 200))
    return res.status(404).json({ error: 'No se pudo extraer audio', detail: String(err instanceof Error ? err.message : err).slice(0, 200) })
  }
}
