/**
 * Serverless Function: login real de Spotify (Authorization Code + PKCE)
 * y proxy autenticado hacia la Web API.
 *
 * Reemplaza lo que antes era código muerto (una copia de
 * api/_lib/spotify.ts que ninguna ruta del frontend llegaba a llamar).
 * El import de playlist PÚBLICA vía Client Credentials sigue viviendo
 * en api/_lib/spotify.ts (usado por api/ytmusic.ts?op=spotifyPlaylist)
 * y no se toca acá — esta función es exclusivamente para el login de
 * usuario y las lecturas que requieren su propio token (sus playlists,
 * incluyendo las colaborativas, y sus Me Gusta — la Web API de Spotify
 * ya no expone eso vía Client Credentials, ver "Get Playlist Items" en
 * la doc oficial).
 *
 * No se suma como 13ª función nueva del proyecto (el plan Hobby de
 * Vercel tope 12): reutiliza este archivo, que ya contaba para el
 * límite pero no hacía nada útil.
 *
 * POST /api/spotify?op=token    body: { code, verifier, redirectUri }
 * POST /api/spotify?op=refresh  body: { refreshToken }
 * GET  /api/spotify?op=proxy&path=<ruta de la Web API, ej. /v1/me/playlists>
 *      header: Authorization: Bearer <access_token del usuario>
 */

import type { VercelRequest, VercelResponse } from '@vercel/node'
import { checkRateLimit, clientIp } from './_lib/rateLimit.ts'

export const config = { maxDuration: 20 }

// MEJORA: sin ningún techo antes. token/refresh pegan contra
// accounts.spotify.com CON el client secret de la app — un abuso ahí no
// solo carga a XFY, puede hacer que Spotify le baje el rate limit a la app
// entera para TODOS los usuarios. Se limita más estricto que proxy (que ya
// exige el access token propio del usuario de Spotify, así que el abuso
// está más acotado).
const TOKEN_LIMIT = { max: 20, windowMs: 15 * 60 * 1000 }
const PROXY_LIMIT = { max: 120, windowMs: 5 * 60 * 1000 }

class HttpError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

function getCredentials(): { clientId: string; clientSecret: string } {
  const clientId = process.env.SPOTIFY_CLIENT_ID
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET
  if (!clientId || !clientSecret) {
    throw new HttpError(500, 'Spotify no está configurado (faltan SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET)')
  }
  return { clientId, clientSecret }
}

function basicAuthHeader(): string {
  const { clientId, clientSecret } = getCredentials()
  return `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`
}

interface SpotifyTokenResponse {
  access_token: string
  refresh_token?: string
  expires_in: number
  scope?: string
  token_type: string
}

async function requestToken(body: URLSearchParams): Promise<SpotifyTokenResponse> {
  const resp = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      Authorization: basicAuthHeader(),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  })
  const data = (await resp.json().catch(() => null)) as (SpotifyTokenResponse & { error?: string; error_description?: string }) | null
  if (!resp.ok || !data) {
    throw new HttpError(resp.status || 502, data?.error_description || data?.error || `Spotify auth falló (${resp.status})`)
  }
  return data
}

/** Intercambia el `code` de vuelta del login por tokens, validando el
 *  code_verifier de PKCE (así el servidor nunca necesita confiar en un
 *  secreto que viaje por el navegador). */
async function exchangeCodeForToken(code: string, verifier: string, redirectUri: string): Promise<SpotifyTokenResponse> {
  const { clientId } = getCredentials()
  return requestToken(
    new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      code_verifier: verifier,
    }),
  )
}

async function refreshToken(refresh: string): Promise<SpotifyTokenResponse> {
  const { clientId } = getCredentials()
  return requestToken(
    new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refresh,
      client_id: clientId,
    }),
  )
}

// Solo estas rutas de la Web API son alcanzables por el proxy — evita que
// esto termine siendo un proxy HTTP abierto hacia api.spotify.com con el
// token de un usuario. Todo lo que necesita XFY hoy entra acá: el perfil,
// sus playlists (propias + colaborativas), sus Me Gusta, y los temas de
// una playlist puntual.
const ALLOWED_PROXY_PATHS = [/^\/v1\/me$/, /^\/v1\/me\/playlists(\?.*)?$/, /^\/v1\/me\/tracks(\?.*)?$/, /^\/v1\/playlists\/[a-zA-Z0-9]+\/tracks(\?.*)?$/]

function isAllowedProxyPath(path: string): boolean {
  return ALLOWED_PROXY_PATHS.some((re) => re.test(path))
}

async function proxySpotify(path: string, accessToken: string): Promise<{ status: number; body: unknown }> {
  const resp = await fetch(`https://api.spotify.com${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  const body = await resp.json().catch(() => null)
  return { status: resp.status, body }
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<VercelResponse | void> {
  const op = String(req.query.op || '')

  try {
    if (op === 'token' || op === 'refresh') {
      const limit = await checkRateLimit(`spotify-token:${clientIp(req)}`, TOKEN_LIMIT.max, TOKEN_LIMIT.windowMs)
      if (!limit.allowed) {
        res.setHeader('Retry-After', String(limit.retryAfterSeconds))
        return res.status(429).json({ error: 'Demasiadas solicitudes, esperá un poco' })
      }
    } else if (op === 'proxy') {
      const limit = await checkRateLimit(`spotify-proxy:${clientIp(req)}`, PROXY_LIMIT.max, PROXY_LIMIT.windowMs)
      if (!limit.allowed) {
        res.setHeader('Retry-After', String(limit.retryAfterSeconds))
        return res.status(429).json({ error: 'Demasiadas solicitudes, esperá un poco' })
      }
    }

    if (op === 'token') {
      const { code, verifier, redirectUri } = (req.body || {}) as { code?: string; verifier?: string; redirectUri?: string }
      if (!code || !verifier || !redirectUri) {
        return res.status(400).json({ error: 'Faltan code / verifier / redirectUri' })
      }
      const data = await exchangeCodeForToken(code, verifier, redirectUri)
      return res.status(200).json(data)
    }

    if (op === 'refresh') {
      const { refreshToken: refresh } = (req.body || {}) as { refreshToken?: string }
      if (!refresh) return res.status(400).json({ error: 'Falta refreshToken' })
      const data = await refreshToken(refresh)
      return res.status(200).json(data)
    }

    if (op === 'proxy') {
      const path = String(req.query.path || '')
      const auth = String(req.headers.authorization || '')
      if (!auth.startsWith('Bearer ')) return res.status(401).json({ error: 'Falta el access token del usuario' })
      if (!isAllowedProxyPath(path)) return res.status(400).json({ error: 'Ruta no permitida' })
      const { status, body } = await proxySpotify(path, auth.slice(7))
      return res.status(status).json(body)
    }

    return res.status(400).json({ error: 'Unknown op' })
  } catch (err) {
    if (err instanceof HttpError) {
      return res.status(err.status).json({ error: err.message })
    }
    console.warn('[spotify] Error:', String(err instanceof Error ? err.message : err).slice(0, 300))
    return res.status(500).json({
      error: 'Internal error',
      detail: String(err instanceof Error ? err.message : err).slice(0, 200),
    })
  }
}
