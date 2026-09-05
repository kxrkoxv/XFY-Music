// ============================================================
// Login real de Spotify (Authorization Code + PKCE) + lecturas de la
// biblioteca del usuario ya autenticado (sus playlists propias y
// colaborativas, sus Me Gusta). Todo pasa por /api/spotify — ver el
// comentario grande en ese archivo sobre por qué el intercambio de
// tokens y las llamadas autenticadas van por el server en vez de
// pegarle directo a accounts.spotify.com / api.spotify.com desde acá.
// ============================================================
import { generateCodeVerifier, generateCodeChallenge, generateState } from '@shared/lib/pkce'

const VERIFIER_KEY = 'xfy_spotify_pkce_verifier'
const STATE_KEY = 'xfy_spotify_pkce_state'

// Solo lectura: playlists propias/colaborativas + Me Gusta. Nada de
// escritura — XFY nunca modifica nada del lado de Spotify.
const SCOPES = ['playlist-read-private', 'playlist-read-collaborative', 'user-library-read'].join(' ')

export function getSpotifyRedirectUri(): string {
  return `${window.location.origin}/spotify-callback`
}

/** Arma la URL de autorización y guarda verifier+state en sessionStorage
 *  (sobreviven la ida y vuelta a accounts.spotify.com, a diferencia de
 *  un estado en memoria de React). Llamar seguido de una navegación de
 *  página completa (`window.location.href = url`), no un push de router. */
export async function buildSpotifyAuthorizeUrl(): Promise<string> {
  const clientId = import.meta.env.VITE_SPOTIFY_CLIENT_ID
  if (!clientId) throw new Error('Falta VITE_SPOTIFY_CLIENT_ID')

  const verifier = generateCodeVerifier()
  const state = generateState()
  sessionStorage.setItem(VERIFIER_KEY, verifier)
  sessionStorage.setItem(STATE_KEY, state)

  const challenge = await generateCodeChallenge(verifier)
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    scope: SCOPES,
    redirect_uri: getSpotifyRedirectUri(),
    code_challenge_method: 'S256',
    code_challenge: challenge,
    state,
  })
  return `https://accounts.spotify.com/authorize?${params.toString()}`
}

export interface SpotifyTokenSet {
  accessToken: string
  refreshToken: string
  expiresAt: number
  scope?: string
}

async function postJson<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = await res.json().catch(() => null)
  if (!res.ok) {
    const err = new Error((data as { error?: string })?.error || `HTTP ${res.status}`) as Error & { status: number }
    err.status = res.status
    throw err
  }
  return data as T
}

interface RawTokenResponse {
  access_token: string
  refresh_token?: string
  expires_in: number
  scope?: string
}

/** Lee code+state de la URL de vuelta, valida contra sessionStorage, y
 *  canjea el code por tokens. Lanza si el `state` no matchea (posible
 *  CSRF) o si no hay verifier guardado (login iniciado en otra pestaña
 *  o sessionStorage limpiado en el medio). */
export async function completeSpotifyLogin(searchParams: URLSearchParams): Promise<SpotifyTokenSet> {
  const code = searchParams.get('code')
  const state = searchParams.get('state')
  const errorParam = searchParams.get('error')
  const verifier = sessionStorage.getItem(VERIFIER_KEY)
  const expectedState = sessionStorage.getItem(STATE_KEY)
  sessionStorage.removeItem(VERIFIER_KEY)
  sessionStorage.removeItem(STATE_KEY)

  if (errorParam) throw new Error(errorParam === 'access_denied' ? 'Cancelaste el login con Spotify.' : errorParam)
  if (!code || !verifier || !state || state !== expectedState) {
    throw new Error('No se pudo validar la vuelta del login de Spotify.')
  }

  const data = await postJson<RawTokenResponse>('/api/spotify?op=token', {
    code,
    verifier,
    redirectUri: getSpotifyRedirectUri(),
  })
  if (!data.refresh_token) throw new Error('Spotify no devolvió un refresh token.')
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + data.expires_in * 1000,
    scope: data.scope,
  }
}

/** Pide un access token nuevo con el refresh token guardado. Spotify a
 *  veces rota el refresh token en la respuesta — si no lo hace, hay que
 *  seguir usando el mismo. */
export async function refreshSpotifyToken(refreshToken: string): Promise<SpotifyTokenSet> {
  const data = await postJson<RawTokenResponse>('/api/spotify?op=refresh', { refreshToken })
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || refreshToken,
    expiresAt: Date.now() + data.expires_in * 1000,
    scope: data.scope,
  }
}

// fetchJsonRobust (httpClient.ts) no soporta headers hoy — todos sus
// otros callers son GETs sin auth — así que esto hace el fetch directo
// en vez de forzarle un contrato nuevo a un helper compartido por medio
// proyecto solo por este caso.
async function authedGet<T>(path: string, accessToken: string): Promise<T> {
  const res = await fetch(`/api/spotify?op=proxy&path=${encodeURIComponent(path)}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  const data = await res.json().catch(() => null)
  if (!res.ok) {
    const err = new Error((data as { error?: string })?.error || `HTTP ${res.status}`) as Error & { status: number }
    err.status = res.status
    throw err
  }
  return data as T
}

export interface SpotifyProfile {
  id: string
  displayName: string | null
  avatarUrl: string | null
}

export async function fetchSpotifyProfile(accessToken: string): Promise<SpotifyProfile> {
  const me = await authedGet<{ id: string; display_name?: string | null; images?: { url: string }[] }>('/v1/me', accessToken)
  return { id: me.id, displayName: me.display_name || null, avatarUrl: me.images?.[0]?.url || null }
}

export interface SpotifyLibraryPlaylist {
  id: string
  name: string
  thumbUrl: string | null
  trackCount: number
  ownedByUser: boolean
}

export interface SpotifyLibrary {
  playlists: SpotifyLibraryPlaylist[]
  likedTracksCount: number
}

interface SpotifyPlaylistsPage {
  items: {
    id: string
    name: string
    images: { url: string }[]
    tracks: { total: number }
    owner: { id: string }
    collaborative: boolean
  }[]
  next: string | null
}

/** Trae TODAS las playlists propias/colaborativas del usuario (paginado
 *  de a 50) más el total de Me Gusta — pensado para poblar la pantalla
 *  de "elegí qué importar" del modal, no para traer los temas todavía
 *  (eso se resuelve por separado, playlist por playlist, solo para lo
 *  que el usuario efectivamente selecciona). */
export async function fetchSpotifyLibrary(accessToken: string, profileId: string): Promise<SpotifyLibrary> {
  const playlists: SpotifyLibraryPlaylist[] = []
  let path: string | null = '/v1/me/playlists?limit=50'
  let guard = 0
  while (path && guard < 10) {
    const page: SpotifyPlaylistsPage = await authedGet<SpotifyPlaylistsPage>(path, accessToken)
    for (const p of page.items || []) {
      // "Get Playlist Items" de Spotify solo deja leer playlists propias
      // o donde el usuario es colaborador — filtramos acá lo que ni
      // vale la pena mostrar como opción de importar.
      if (p.owner?.id === profileId || p.collaborative) {
        playlists.push({
          id: p.id,
          name: p.name,
          thumbUrl: p.images?.[0]?.url || null,
          trackCount: p.tracks?.total || 0,
          ownedByUser: p.owner?.id === profileId,
        })
      }
    }
    path = page.next ? page.next.replace('https://api.spotify.com', '') : null
    guard += 1
  }

  const liked = await authedGet<{ total: number }>('/v1/me/tracks?limit=1', accessToken)
  return { playlists, likedTracksCount: liked.total || 0 }
}

export interface SpotifyRawTrack {
  spotifyId: string | null
  title: string
  artist: string
  album: string | null
  thumbUrl: string | null
  durationMs: number
}

interface SpotifyPlaylistTrackItem {
  track: {
    id: string | null
    name: string
    duration_ms: number
    artists: { name: string }[]
    album: { name: string; images: { url: string }[] } | null
  } | null
}

interface SpotifyTracksPage {
  items: SpotifyPlaylistTrackItem[]
  next: string | null
}

function mapTrackItem(item: SpotifyPlaylistTrackItem): SpotifyRawTrack | null {
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

/** Trae todos los temas de UNA playlist del usuario (paginado). */
export async function fetchSpotifyPlaylistTracks(accessToken: string, playlistId: string): Promise<SpotifyRawTrack[]> {
  const tracks: SpotifyRawTrack[] = []
  let path: string | null = `/v1/playlists/${encodeURIComponent(playlistId)}/tracks?limit=100`
  let guard = 0
  while (path && guard < 20) {
    const page: SpotifyTracksPage = await authedGet<SpotifyTracksPage>(path, accessToken)
    for (const item of page.items || []) {
      const mapped = mapTrackItem(item)
      if (mapped) tracks.push(mapped)
    }
    path = page.next ? page.next.replace('https://api.spotify.com', '') : null
    guard += 1
  }
  return tracks
}

interface SpotifySavedTracksPage {
  items: SpotifyPlaylistTrackItem[]
  next: string | null
}

/** Trae todos los Me Gusta del usuario (paginado). */
export async function fetchSpotifyLikedTracks(accessToken: string): Promise<SpotifyRawTrack[]> {
  const tracks: SpotifyRawTrack[] = []
  let path: string | null = '/v1/me/tracks?limit=50'
  let guard = 0
  while (path && guard < 40) {
    const page: SpotifySavedTracksPage = await authedGet<SpotifySavedTracksPage>(path, accessToken)
    for (const item of page.items || []) {
      const mapped = mapTrackItem(item)
      if (mapped) tracks.push(mapped)
    }
    path = page.next ? page.next.replace('https://api.spotify.com', '') : null
    guard += 1
  }
  return tracks
}
