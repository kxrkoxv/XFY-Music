/**
 * Helper de Spotify — NO es un endpoint (no tiene `export default handler`,
 * así que Vercel no lo cuenta como Serverless Function). Se llama desde
 * api/ytmusic.ts (op=spotifyPlaylist) para no sumar una función nueva:
 * el plan Hobby de Vercel tiene un tope de 12 Serverless Functions y este
 * proyecto ya lo tenía justo al límite.
 *
 * Resuelve playlists públicas de Spotify vía Client Credentials (no
 * requiere que el usuario inicie sesión con su cuenta de Spotify).
 * Requiere las env vars SPOTIFY_CLIENT_ID y SPOTIFY_CLIENT_SECRET.
 */

export class SpotifyError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

interface SpotifyToken {
  token: string
  expiresAt: number
}

// El token de client-credentials dura 1h y se reutiliza entre invocaciones
// tibias de la función — mismo patrón que el cliente cacheado de ytmusic.ts.
let cachedToken: SpotifyToken | null = null

async function getAccessToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 5000) return cachedToken.token

  const clientId = process.env.SPOTIFY_CLIENT_ID
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET
  if (!clientId || !clientSecret) {
    throw new SpotifyError(500, 'Spotify no está configurado (faltan SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET)')
  }

  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64')
  const resp = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  })
  if (!resp.ok) {
    throw new SpotifyError(502, `Spotify auth falló (${resp.status})`)
  }
  const data = (await resp.json()) as { access_token: string; expires_in: number }
  cachedToken = { token: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 }
  return cachedToken.token
}

/** Acepta un link completo (open.spotify.com/playlist/ID), un URI
 *  (spotify:playlist:ID) o directamente el ID. */
function extractPlaylistId(input: string): string | null {
  const raw = String(input || '').trim()
  if (!raw) return null
  const uriMatch = raw.match(/spotify:playlist:([a-zA-Z0-9]+)/)
  if (uriMatch?.[1]) return uriMatch[1]
  const urlMatch = raw.match(/open\.spotify\.com\/(?:intl-[a-z-]+\/)?playlist\/([a-zA-Z0-9]+)/)
  if (urlMatch?.[1]) return urlMatch[1]
  if (/^[a-zA-Z0-9]{10,}$/.test(raw)) return raw
  return null
}

interface SpotifyImage {
  url: string
}

interface SpotifyArtist {
  name: string
}

interface SpotifyTrack {
  id: string | null
  name: string
  duration_ms: number
  artists: SpotifyArtist[]
  album: { name: string; images: SpotifyImage[] } | null
}

interface SpotifyTrackItem {
  track: SpotifyTrack | null
}

interface SpotifyPlaylistPage {
  name: string
  images: SpotifyImage[]
  owner: { display_name?: string | null }
  tracks: {
    items: SpotifyTrackItem[]
    next: string | null
  }
}

export interface SpotifyRawTrack {
  spotifyId: string | null
  title: string
  artist: string
  album: string | null
  thumbUrl: string | null
  durationMs: number
}

export interface SpotifyPlaylistResult {
  id: string
  title: string
  author: string | null
  thumbUrl: string | null
  tracks: SpotifyRawTrack[]
}

async function spotifyFetch<T>(url: string, token: string): Promise<T> {
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
  if (resp.status === 404) throw new SpotifyError(404, 'Playlist no encontrada (¿es pública?)')
  if (!resp.ok) throw new SpotifyError(resp.status, `Spotify respondió ${resp.status}`)
  return (await resp.json()) as T
}

function mapTrack(item: SpotifyTrackItem): SpotifyRawTrack | null {
  const t = item?.track
  if (!t || !t.name) return null
  return {
    spotifyId: t.id || null,
    title: t.name,
    artist: (t.artists || []).map((a) => a.name).filter(Boolean).join(', '),
    album: t.album?.name || null,
    thumbUrl: t.album?.images?.[0]?.url || null,
    durationMs: t.duration_ms || 0,
  }
}

/** Resuelve un link/URI/ID de playlist de Spotify a su metadata + temas
 *  crudos (sin videoId de YouTube — eso lo hace el cliente por su cuenta,
 *  pegándole a op=search por cada tema). */
export async function resolveSpotifyPlaylist(urlOrId: string): Promise<SpotifyPlaylistResult> {
  const playlistId = extractPlaylistId(urlOrId)
  if (!playlistId) throw new SpotifyError(400, 'Link de playlist de Spotify inválido')

  const token = await getAccessToken()
  const fields =
    'name,images,owner.display_name,tracks.next,tracks.items(track(id,name,duration_ms,artists(name),album(name,images)))'
  const page = await spotifyFetch<SpotifyPlaylistPage>(
    `https://api.spotify.com/v1/playlists/${encodeURIComponent(playlistId)}?fields=${encodeURIComponent(fields)}`,
    token,
  )

  // Spotify a veces responde 200 con un body que no tiene la forma
  // esperada (playlists algorítmicas, "starred" viejas, o cambios de
  // formato) — sin este chequeo, `page.tracks.items` explota con un
  // TypeError genérico. Con el chequeo, el modal muestra un mensaje
  // legible en vez de un 500 críptico.
  if (!page || !page.tracks || !Array.isArray(page.tracks.items)) {
    throw new SpotifyError(502, 'Spotify no devolvió los temas de esa playlist (¿es privada, colaborativa vacía o generada automáticamente por Spotify?)')
  }

  const tracks: SpotifyRawTrack[] = []
  for (const item of page.tracks.items) {
    const mapped = mapTrack(item)
    if (mapped) tracks.push(mapped)
  }

  let nextUrl = page.tracks.next
  let guard = 0
  // Playlists grandes vienen paginadas de a 100 — seguimos `next` hasta
  // agotarla, con un tope de seguridad para no correr indefinidamente.
  while (nextUrl && guard < 20) {
    const nextPage = await spotifyFetch<{ items: SpotifyTrackItem[]; next: string | null }>(nextUrl, token)
    for (const item of nextPage.items || []) {
      const mapped = mapTrack(item)
      if (mapped) tracks.push(mapped)
    }
    nextUrl = nextPage.next
    guard += 1
  }

  return {
    id: playlistId,
    title: page.name || 'Playlist importada',
    author: page.owner?.display_name || null,
    thumbUrl: page.images?.[0]?.url || null,
    tracks,
  }
}
