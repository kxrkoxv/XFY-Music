/**
 * Serverless Function: proxy de bytes hacia googlevideo con soporte Range.
 *
 * Motivo de existencia: las URLs firmadas de googlevideo están ligadas a la
 * IP que las generó. Si api/ytaudio mintió la URL desde una IP de Vercel y
 * el navegador la pide desde otra red, a veces recibe 403. Este endpoint
 * re-resuelve (con el cache compartido de ytcore) y sirve los bytes desde
 * el mismo origen que firmó la URL. De paso agrega CORS, lo que habilita
 * que el caché de audio del frontend (Cache Storage) funcione igual que
 * con cualquier otra pista externa.
 *
 * OJO: usa SOLO la API nativa de Node de res (setHeader/statusCode/end),
 * nada de los helpers .status().json() de Vercel — el middleware de dev
 * (vite.config.js) le pasa el res crudo del server de Vite, que no tiene
 * esos helpers. Mismo código corre idéntico en ambos entornos.
 *
 * GET /api/ytstream?videoId=XXX  (headers Range se pasan tal cual)
 */import { Readable } from 'node:stream'
import type { VercelRequest, VercelResponse } from '@vercel/node'
import { resolveAudioUrl } from './_lib/ytcore.ts'
import { checkRateLimit, clientIp } from './_lib/rateLimit.ts'

export const config = { maxDuration: 60 }

// MEJORA: este es el proxy de bytes real que usa la reproducción — el
// browser dispara varios requests Range por canción al buscar/seekear, así
// que el techo tiene que ser bastante más generoso que en ytaudio.ts (que
// solo resuelve una vez por canción). 300 / 5 min por IP deja escuchar
// música sin fricción y sigue frenando un script que solo quiere abusar del
// proxy hacia googlevideo.
const YTSTREAM_LIMIT = { max: 300, windowMs: 5 * 60 * 1000 }

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

function sendJson(res: VercelResponse, code: number, data: unknown): void {
  if (res.headersSent) return void res.end()
  res.statusCode = code
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(data))
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  const videoId = String(req.query?.videoId || '').trim()
  if (!videoId || !/^[A-Za-z0-9_-]{11}$/.test(videoId)) {
    return sendJson(res, 400, { error: 'videoId inválido o faltante' })
  }

  const limit = await checkRateLimit(`ytstream:${clientIp(req)}`, YTSTREAM_LIMIT.max, YTSTREAM_LIMIT.windowMs)
  if (!limit.allowed) {
    res.setHeader('Retry-After', String(limit.retryAfterSeconds))
    return sendJson(res, 429, { error: 'Demasiadas solicitudes, esperá un poco' })
  }

  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
  res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges')
  if (req.method === 'OPTIONS') {
    res.statusCode = 204
    res.end()
    return
  }

  try {
    const resolved = await resolveAudioUrl(videoId)
    if (!resolved) return sendJson(res, 404, { error: 'No se pudo extraer audio para este video' })

    // Normalmente solo se proxyea googlevideo. Cuando resolveAudioUrl cayó
    // al fallback externo (Piped/Invidious — ver _lib/pipedFallback.ts,
    // `client` viene marcado "piped:host"/"invidious:host"), el origen
    // legítimo es esa instancia de terceros, así que se permite su host
    // puntual en vez de exigir googlevideo. Fuera de esos dos casos, nada
    // de hosts raros aunque alguien manipule la respuesta del resolutor o
    // googlevideo redirija a otro lado.
    const isFallbackClient = resolved.client.startsWith('piped:') || resolved.client.startsWith('invidious:')
    const allowedHost = isFallbackClient ? new URL(resolved.url).hostname : null
    const isAllowedHost = (u: string) => {
      const host = new URL(u).hostname
      if (/(^|\.)googlevideo\.com$/.test(host)) return true
      return isFallbackClient && host === allowedHost
    }
    if (!isAllowedHost(resolved.url)) {
      return sendJson(res, 502, { error: 'URL de origen no permitida' })
    }

    const headers: Record<string, string> = { 'User-Agent': BROWSER_UA }
    const range = req.headers?.range
    if (range) headers.Range = Array.isArray(range) ? range.join(',') : range

    const upstream = await fetch(resolved.url, { headers })
    // Un redirect puede caer en otro host CDN: se valida también la URL
    // final, después de seguir redirects.
    if (!isAllowedHost(upstream.url)) {
      try {
        await upstream.body?.cancel?.()
      } catch {
        /* noop */
      }
      return sendJson(res, 502, { error: 'Redirect fuera de googlevideo bloqueado' })
    }
    // 416 pasa tal cual: es la respuesta válida a un Range ya consumido,
    // el <audio> del navegador sabe manejarla.
    if (!upstream.ok && upstream.status !== 206 && upstream.status !== 416) {
      try {
        await upstream.body?.cancel?.()
      } catch {
        /* noop */
      }
      return sendJson(res, 502, { error: `googlevideo respondió ${upstream.status}` })
    }

    res.statusCode = upstream.status
    res.setHeader('Accept-Ranges', 'bytes')
    const type = upstream.headers.get('content-type')
    if (type) res.setHeader('Content-Type', type)
    const len = upstream.headers.get('content-length')
    if (len) res.setHeader('Content-Length', len)
    const contentRange = upstream.headers.get('content-range')
    if (contentRange) res.setHeader('Content-Range', contentRange)

    if (!upstream.body) {
      res.end()
      return
    }

    const nodeStream = Readable.fromWeb(upstream.body as import('node:stream/web').ReadableStream<Uint8Array>)
    nodeStream.on('error', (err: Error) => {
      console.warn('[ytstream] Error de stream:', String(err?.message || err).slice(0, 120))
      res.end()
    })
    // Seek/abort del navegador: cortar también la descarga upstream para no
    // seguir quemando bandwidth server-side con un request que ya nadie lee.
    res.on('close', () => {
      if (!res.writableEnded) nodeStream.destroy()
    })
    nodeStream.pipe(res)
  } catch (err) {
    console.warn('[ytstream] Error inesperado:', String(err instanceof Error ? err.message : err).slice(0, 200))
    sendJson(res, 502, {
      error: 'Fallo proxyeando audio',
      detail: String(err instanceof Error ? err.message : err).slice(0, 200),
    })
  }
}
