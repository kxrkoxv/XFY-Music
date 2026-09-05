/**
 * Serverless Function: descarga de una canción con metadata etiquetada
 * (título/artista/álbum + carátula embebida) — feature inspirada
 * directamente en "Freely downloadable tracks with tagged metadata" de
 * Spotube.
 *
 * GET /api/download?videoId=XXX&title=...&artist=...&album=...&cover=<url>
 *   → stream del archivo de audio con tags embebidos, Content-Disposition
 *     attachment (el navegador lo guarda como "Artista - Título.m4a").
 *
 * Reusa resolveAudioUrl (mismo pipeline que ytstream.ts: Innertube +
 * BotGuard + fallback Piped/Invidious) en vez de depender de que la
 * canción ya esté en el caché tiered — así funciona también para
 * canciones recién resueltas que todavía no pasaron por /api/ytcache.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node'
import { resolveAudioUrl } from './_lib/ytcore.ts'
import { tagAudio } from './_lib/tagAudio.ts'
import { isPublicHttpUrl } from './_lib/ssrfGuard.ts'
import { checkRateLimit, clientIp } from './_lib/rateLimit.ts'

export const config = { maxDuration: 60 }

// MEJORA: este endpoint es público (sin sesión) y dispara lo más caro del
// sistema — resolución Innertube/BotGuard + fetch del audio completo +
// ffmpeg tagueando — sin ningún techo antes. 15 descargas / 5 min por IP
// alcanza de sobra para un uso real y convierte un abuso masivo en algo
// lento y visible, mismo criterio que ya usa ytcache.ts.
const DOWNLOAD_LIMIT = { max: 15, windowMs: 5 * 60 * 1000 }

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const MAX_COVER_BYTES = 5 * 1024 * 1024
const FETCH_TIMEOUT_MS = 15000

function sendJson(res: VercelResponse, code: number, data: unknown): void {
  if (res.headersSent) return void res.end()
  res.statusCode = code
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(data))
}

/** Nombre de archivo seguro: sin separadores de path ni caracteres que
 *  rompan el header Content-Disposition. */
function safeFilenamePart(value: string): string {
  return value.replace(/[\\/:*?"<>|]/g, '').trim().slice(0, 80) || 'XFY'
}

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { headers: { 'User-Agent': BROWSER_UA }, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
  if (req.method === 'OPTIONS') {
    res.statusCode = 204
    res.end()
    return
  }

  const limit = await checkRateLimit(`download:${clientIp(req)}`, DOWNLOAD_LIMIT.max, DOWNLOAD_LIMIT.windowMs)
  if (!limit.allowed) {
    res.setHeader('Retry-After', String(limit.retryAfterSeconds))
    return sendJson(res, 429, { error: 'Demasiadas descargas, esperá un poco' })
  }

  const videoId = String(req.query?.videoId || '').trim()
  if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) {
    return sendJson(res, 400, { error: 'videoId inválido o faltante' })
  }
  const title = String(req.query?.title || 'Pista desconocida').trim().slice(0, 200)
  const artist = String(req.query?.artist || 'Artista desconocido').trim().slice(0, 200)
  const album = req.query?.album ? String(req.query.album).trim().slice(0, 200) : undefined
  const coverUrl = req.query?.cover ? String(req.query.cover) : ''

  try {
    const resolved = await resolveAudioUrl(videoId)
    if (!resolved?.url) return sendJson(res, 404, { error: 'No se pudo extraer audio para este video' })

    const audioRes = await fetchWithTimeout(resolved.url, FETCH_TIMEOUT_MS)
    if (!audioRes.ok) return sendJson(res, 502, { error: 'No se pudo descargar el audio de origen' })
    const audioBuffer = Buffer.from(await audioRes.arrayBuffer())

    // La carátula es best-effort: si falla la descarga o pesa demasiado,
    // seguimos sin ella en vez de fallar la descarga entera.
    let coverBuffer: Buffer<ArrayBuffer> | null = null
    // MEJORA (SSRF): `cover` viene tal cual del query string del cliente y
    // antes se fetcheaba sin ninguna validación — cualquiera podía pasar
    // una URL apuntando a un servicio interno (metadata de la nube,
    // localhost, una IP de red privada) y el SERVIDOR hacía esa request en
    // su nombre. isPublicHttpUrl resuelve el hostname y rechaza cualquier
    // IP privada/loopback/link-local antes de fetchear.
    if (coverUrl && (await isPublicHttpUrl(coverUrl))) {
      try {
        const coverRes = await fetchWithTimeout(coverUrl, FETCH_TIMEOUT_MS)
        if (coverRes.ok) {
          const buf = Buffer.from(await coverRes.arrayBuffer())
          if (buf.length > 0 && buf.length <= MAX_COVER_BYTES) coverBuffer = buf
        }
      } catch {
        /* sin carátula, no es fatal */
      }
    }

    const tagged = await tagAudio(audioBuffer, resolved.mimeType, { title, artist, album }, coverBuffer)

    const filename = `${safeFilenamePart(artist)} - ${safeFilenamePart(title)}.${tagged.ext}`
    res.setHeader('Content-Type', tagged.ext === 'webm' ? 'audio/webm' : 'audio/mp4')
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
    res.setHeader('Content-Length', String(tagged.buffer.length))
    res.statusCode = 200
    res.end(tagged.buffer)
  } catch (err) {
    console.warn('[download] Error inesperado:', String(err instanceof Error ? err.message : err).slice(0, 200))
    sendJson(res, 502, { error: 'No se pudo preparar la descarga' })
  }
}
