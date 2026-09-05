/**
 * Serverless Function fusionada: proxy de imágenes externas (antes
 * api/imgproxy.ts) + proxy de MusicBrainz (antes api/musicbrainz.ts).
 *
 * Se unificaron en un solo archivo para no sumar una 13ª Serverless
 * Function — el plan Hobby de Vercel tope en 12 (ver vercel.json). Cada
 * bloque de lógica es EXACTAMENTE el mismo que tenían los dos archivos
 * separados, solo detrás de un dispatch por `?kind=`. Las rutas viejas
 * /api/imgproxy y /api/musicbrainz se preservan vía rewrites en
 * vercel.json — cero cambios en el código del cliente.
 *
 * GET /api/proxyutils?kind=img&url=<url>
 * GET /api/proxyutils?kind=musicbrainz&resource=<endpoint>&<resto>
 */

import type { VercelRequest, VercelResponse } from '@vercel/node'

export const config = { maxDuration: 15 }

// ============================================================
// --- Bloque 1: proxy de imágenes (ex api/imgproxy.ts) ---
// ============================================================

const IMG_ALLOWED_DOMAINS = [
  'www.theaudiodb.com',
  'theaudiodb.com',
  'r2.theaudiodb.com',
  'coverartarchive.org',
  'ia800502.us.archive.org',
  'archive.org',
]

interface ImgCacheEntry {
  buffer: Buffer
  contentType: string
  time: number
}

const IMG_CACHE = new Map<string, ImgCacheEntry>()
const IMG_CACHE_TTL = 1000 * 60 * 60 * 24 * 7 // 7 días

const IMG_NEGATIVE_CACHE = new Map<string, number>()
const IMG_NEGATIVE_TTL = 1000 * 60 * 10 // 10 min

const IMG_SUCCESS_CACHE_HEADERS = 'public, max-age=604800, s-maxage=604800, stale-while-revalidate=86400'
const IMG_MISSING_CACHE_HEADERS = 'public, max-age=300, s-maxage=600'

async function handleImgProxy(req: VercelRequest, res: VercelResponse): Promise<VercelResponse | void> {
  const rawParam = req.query.url
  const rawUrl = Array.isArray(rawParam) ? rawParam[0] : rawParam
  if (!rawUrl) {
    return res.status(400).json({ error: 'Missing url param' })
  }

  let decoded: string
  try {
    decoded = decodeURIComponent(rawUrl)
    decoded = decoded.replace(/^http:\/\//i, 'https://')
    const parsed = new URL(decoded)
    if (!IMG_ALLOWED_DOMAINS.some((d) => parsed.hostname === d || parsed.hostname.endsWith('.' + d))) {
      return res.status(403).json({ error: 'Domain not allowed' })
    }
  } catch {
    return res.status(400).json({ error: 'Invalid url' })
  }

  const negativeAt = IMG_NEGATIVE_CACHE.get(decoded)
  if (negativeAt && Date.now() - negativeAt < IMG_NEGATIVE_TTL) {
    res.setHeader('Cache-Control', IMG_MISSING_CACHE_HEADERS)
    return res.status(404).json({ error: 'Image not found (cached)' })
  }

  const cached = IMG_CACHE.get(decoded)
  if (cached && Date.now() - cached.time < IMG_CACHE_TTL) {
    res.setHeader('Content-Type', cached.contentType)
    res.setHeader('Cache-Control', IMG_SUCCESS_CACHE_HEADERS)
    res.setHeader('Access-Control-Allow-Origin', '*')
    return res.end(cached.buffer)
  }

  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 8000)
    let upstream: Response
    try {
      upstream = await fetch(decoded, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; XFY-proxy/1.0)',
          Accept: 'image/webp,image/avif,image/*,*/*',
        },
        signal: controller.signal,
      })
    } finally {
      clearTimeout(timeout)
    }

    if (!upstream.ok) {
      IMG_NEGATIVE_CACHE.set(decoded, Date.now())
      res.setHeader('Cache-Control', IMG_MISSING_CACHE_HEADERS)
      res.setHeader('Access-Control-Allow-Origin', '*')
      return res.status(upstream.status).json({ error: 'Upstream failed' })
    }

    const buffer = Buffer.from(await upstream.arrayBuffer())
    const contentType = upstream.headers.get('content-type') || 'image/jpeg'

    if (contentType.startsWith('image/')) {
      IMG_CACHE.set(decoded, { buffer, contentType, time: Date.now() })
    }

    res.setHeader('Content-Type', contentType)
    res.setHeader('Cache-Control', IMG_SUCCESS_CACHE_HEADERS)
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.end(buffer)
  } catch (err) {
    res.setHeader('Access-Control-Allow-Origin', '*')
    const timedOut = err instanceof Error && err.name === 'AbortError'
    return res.status(timedOut ? 504 : 502).json({
      error: timedOut ? 'Upstream timeout' : 'Proxy fetch failed',
      detail: err instanceof Error ? err.message : String(err),
    })
  }
}

// ============================================================
// --- Bloque 2: proxy de MusicBrainz (ex api/musicbrainz.ts) ---
// ============================================================

const MUSICBRAINZ_BASE = 'https://musicbrainz.org/ws/2'
const MB_USER_AGENT = 'XFY-music-player/1.0 (https://xfy-react-3rvj.vercel.app)'

interface MbCacheEntry {
  data: unknown
  time: number
}

const MB_CACHE = new Map<string, MbCacheEntry>()
const MB_CACHE_TTL = 1000 * 60 * 60 * 24 // 24 horas
const MB_CACHE_MAX_ENTRIES = 150

const MB_UPSTREAM_TIMEOUT_MS = 4000
const MB_RETRY_DELAY_MS = 1200
const MB_RETRYABLE_STATUS = new Set([429, 503])

async function mbFetchUpstream(url: string): Promise<Response> {
  let lastError: unknown
  let lastResponse: Response | undefined
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (attempt > 0) {
      await new Promise((resolve) => setTimeout(resolve, MB_RETRY_DELAY_MS))
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), MB_UPSTREAM_TIMEOUT_MS)
    try {
      const upstream = await fetch(url, {
        headers: { 'User-Agent': MB_USER_AGENT, Accept: 'application/json' },
        signal: controller.signal,
      })
      if (upstream.ok || !MB_RETRYABLE_STATUS.has(upstream.status)) return upstream
      lastResponse = upstream
      lastError = new Error(`MusicBrainz upstream returned ${upstream.status}`)
    } catch (err) {
      lastError = err
    } finally {
      clearTimeout(timer)
    }
  }
  if (lastResponse) return lastResponse
  throw lastError
}

function mbPruneCache(): void {
  while (MB_CACHE.size >= MB_CACHE_MAX_ENTRIES) {
    const oldest = MB_CACHE.keys().next().value
    if (oldest === undefined) break
    MB_CACHE.delete(oldest)
  }
}

function mbSendJson(res: VercelResponse, data: unknown, freshness: 'fresh' | 'stale'): void {
  res.setHeader('Content-Type', 'application/json')
  res.setHeader('Access-Control-Allow-Origin', '*')
  if (freshness === 'stale') {
    res.setHeader('Cache-Control', 'public, max-age=300')
    res.setHeader('X-MusicBrainz-Cache', 'stale')
  } else {
    res.setHeader('Cache-Control', 'public, max-age=86400')
  }
  res.end(JSON.stringify(data))
}

function mbQueryToString(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value.join(',') : value ?? ''
}

async function handleMusicbrainz(req: VercelRequest, res: VercelResponse): Promise<VercelResponse | void> {
  const qs = req.query || {}
  const resource = mbQueryToString(qs.resource)

  if (!resource) {
    return res.status(400).json({ error: 'Missing ?resource param' })
  }

  const restQuery: Record<string, string> = {}
  for (const [key, value] of Object.entries(qs)) {
    if (key !== 'resource' && key !== 'kind' && value !== undefined) restQuery[key] = mbQueryToString(value)
  }
  const upstreamParams = new URLSearchParams(restQuery)
  if (!upstreamParams.has('fmt')) upstreamParams.set('fmt', 'json')

  const cacheKey = `${resource}:${upstreamParams.toString()}`
  const cached = MB_CACHE.get(cacheKey)
  if (cached && Date.now() - cached.time < MB_CACHE_TTL) {
    mbSendJson(res, cached.data, 'fresh')
    return
  }

  const upstreamUrl = `${MUSICBRAINZ_BASE}/${resource}?${upstreamParams.toString()}`

  try {
    const upstream = await mbFetchUpstream(upstreamUrl)
    const text = upstream.ok ? await upstream.text() : ''

    let data: unknown = null
    if (text.trim().startsWith('{') || text.trim().startsWith('[')) {
      try {
        data = JSON.parse(text)
      } catch {
        data = null
      }
    }

    if (data != null) {
      mbPruneCache()
      MB_CACHE.set(cacheKey, { data, time: Date.now() })
      mbSendJson(res, data, 'fresh')
      return
    }

    const preview = text.slice(0, 120)
    console.error(`[XFY] MusicBrainz upstream falló: status=${upstream.status} body=${preview}`)
    if (cached) {
      mbSendJson(res, cached.data, 'stale')
      return
    }
    if (!upstream.ok) {
      return res.status(upstream.status).json({ error: `MusicBrainz upstream returned ${upstream.status}` })
    }
    if (text && !text.trim().startsWith('{') && !text.trim().startsWith('[')) {
      return res.status(503).json({ error: 'MusicBrainz returned non-JSON response' })
    }
    return res.status(502).json({ error: 'Failed to parse MusicBrainz response' })
  } catch (err) {
    if (cached) {
      mbSendJson(res, cached.data, 'stale')
      return
    }
    return res.status(502).json({ error: 'MusicBrainz proxy failed', detail: err instanceof Error ? err.message : String(err) })
  }
}

// ============================================================
// --- Dispatcher ---
// ============================================================

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<VercelResponse | void> {
  const kind = Array.isArray(req.query.kind) ? req.query.kind[0] : req.query.kind
  if (kind === 'musicbrainz') return handleMusicbrainz(req, res)
  if (kind === 'img') return handleImgProxy(req, res)
  return res.status(400).json({ error: 'Missing or unknown ?kind param (esperado: img | musicbrainz)' })
}
