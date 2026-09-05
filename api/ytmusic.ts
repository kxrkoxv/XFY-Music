/**
 * Serverless Function: búsqueda y metadata de YouTube Music.
 *
 * Corre ytmusic-api directamente en la función, sin proxy externo.
 * Nota: YouTube suele bloquear los rangos de IP de datacenter que usan
 * los proveedores serverless. Si las respuestas empiezan a fallar de
 * forma consistente, ese es el motivo más probable — en ese caso hace
 * falta volver a poner esto detrás de un host con IP residencial, o
 * configurar YTMUSIC_COOKIE con una sesión real.
 *
 * GET /api/ytmusic?op=<search|searchArtists|searchPlaylists|artist|album|playlist|song|lyrics|trending|related|spotifyPlaylist>
 */

import YTMusic from 'ytmusic-api'
import type { VercelRequest, VercelResponse } from '@vercel/node'
import { resolveSpotifyPlaylist, SpotifyError } from './_lib/spotify.ts'
import { checkRateLimit, clientIp } from './_lib/rateLimit.ts'

export const config = { maxDuration: 30 }

// MEJORA: público y sin techo antes — la caché de 5 min ya amortigua
// búsquedas repetidas, pero un scraper variando queries evita la caché por
// completo. 120 requests / 5 min por IP (cualquier op) alcanza de sobra
// para uso real de búsqueda/metadata.
const YTMUSIC_LIMIT = { max: 120, windowMs: 5 * 60 * 1000 }

const CACHE_TTL_MS = 5 * 60 * 1000
const cache = new Map<string, { data: unknown; time: number }>()

function getCached(key: string): unknown {
  const entry = cache.get(key)
  if (!entry || Date.now() - entry.time > CACHE_TTL_MS) return null
  return entry.data
}

function setCached(key: string, data: unknown): void {
  cache.set(key, { data, time: Date.now() })
}

// El cliente se reutiliza entre invocaciones dentro de la misma instancia
// tibia de la función. Si la inicialización falla, se descarta para no
// quedar cacheado en un estado roto.
let clientPromise: Promise<YTMusic> | null = null
function getClient(): Promise<YTMusic> {
  if (!clientPromise) {
    const ytmusic = new YTMusic()
    const cookie = process.env.YTMUSIC_COOKIE || undefined
    clientPromise = ytmusic.initialize(cookie ? { cookies: cookie } : undefined).then(
      () => ytmusic,
      (err: unknown) => {
        clientPromise = null
        throw err
      },
    )
  }
  return clientPromise
}

// -----------------------------------------------------------------------
// Shapes crudos que consume este endpoint. La librería trae sus propios
// tipos, pero los campos que acá se leen son opcionales en la práctica
// (ítems de playlist sin thumbnails, canciones sin álbum, etc.) — se
// tipan como "lo mínimo que el mapeo tolera" y se castea una sola vez,
// en el borde con la librería.
// -----------------------------------------------------------------------

interface RawThumb {
  url?: string | null
}

interface RawArtistRef {
  name?: string | null
  artistId?: string | null
  id?: string | null
}

interface RawSong {
  videoId?: string | null
  name?: string | null
  album?: { name?: string | null } | null
  artist?: RawArtistRef | null
  artists?: RawArtistRef[] | null
  thumbnails?: RawThumb[] | null
  duration?: number | string | null
}

interface RawArtist {
  artistId?: string | null
  name?: string | null
  thumbnails?: RawThumb[] | null
  description?: string | null
  topAlbums?: RawAlbumBasic[] | null
  topSingles?: RawAlbumBasic[] | null
}

interface RawAlbumBasic {
  albumId?: string | null
  playlistId?: string | null
  browseId?: string | null
  name?: string | null
  title?: string | null
  year?: string | number | null
  thumbnails?: RawThumb[] | null
}

interface RawAlbumFull extends RawAlbumBasic {
  artist?: RawArtistRef | null
  artists?: RawArtistRef[] | null
  songs?: RawSong[] | null
  tracks?: RawSong[] | null
}

interface RawPlaylistEntry {
  playlistId?: string | null
  albumId?: string | null
  browseId?: string | null
  name?: string | null
  title?: string | null
  artist?: RawArtistRef | null
  channelName?: string | null
  subtitle?: string | null
  trackCount?: number | null
  thumbnails?: RawThumb[] | null
}

interface RawPlaylistFull extends RawPlaylistEntry {
  songs?: RawSong[] | null
  tracks?: RawSong[] | null
  videos?: RawSong[] | null
}

/** Forma que devuelve ytmusic-api#getUpNexts — es la cola "radio"/relacionados
 *  que arma YT Music a partir de una canción (mismo motor que autoplay en
 *  music.youtube.com). Nota: `title` en vez de `name`, y `artists` viene
 *  como objeto único, no array — por eso necesita su propio mapper. */
interface RawUpNext {
  videoId?: string | null
  title?: string | null
  artists?: RawArtistRef | null
  thumbnails?: RawThumb[] | null
  duration?: number | string | null
}

/** Canción ya normalizada que consume el frontend. */
interface MappedSong {
  id: string
  videoId: string
  title: string
  artist: string
  artistId: string | null
  artists: { name: string | null; artistId: string | null }[]
  album: string | null
  albumArtUrl: string | null
  source: 'youtube'
  duration: number
}

/** Sube la resolución de thumbnails alojados en Google a 1200x1200. */
function upscaleThumb(url: string | null | undefined): string | null {
  if (!url) return url ?? null
  if (/\.googleusercontent\.com\//.test(url) && /=w\d+-h\d+/.test(url)) {
    return url.replace(/=w\d+-h\d+/, '=w1200-h1200')
  }
  return url
}

function bestThumb(thumbnails?: RawThumb[] | null): string | null {
  if (!thumbnails?.length) return null
  return upscaleThumb(thumbnails[thumbnails.length - 1]?.url ?? null)
}

/** Normaliza el campo de artistas sin importar si vino como 'artist' o 'artists'. */
function normalizeArtists(song: RawSong): { name: string | null; artistId: string | null }[] {
  const list =
    Array.isArray(song?.artists) && song.artists.length > 0
      ? song.artists
      : song?.artist
        ? [song.artist]
        : []
  return list
    .map((a) => ({ name: a?.name || null, artistId: a?.artistId || a?.id || null }))
    .filter((a): a is { name: string; artistId: string | null } => Boolean(a.name))
}

function mapSong(song?: RawSong | null): MappedSong | null {
  if (!song?.videoId) return null
  const artists = normalizeArtists(song)
  return {
    id: song.videoId,
    videoId: song.videoId,
    title: song.name || 'Sin título',
    artist: artists.length ? artists.map((a) => a.name).join(', ') : 'Desconocido',
    artistId: artists[0]?.artistId || null,
    artists,
    album: song.album?.name || null,
    albumArtUrl: bestThumb(song.thumbnails),
    source: 'youtube',
    duration: typeof song.duration === 'number' ? song.duration : 0,
  }
}

/** Mapea un ítem de getUpNexts() al mismo shape de MappedSong que ya
 *  consume el resto del cliente (queue, playlists, etc.). */
function mapUpNext(item?: RawUpNext | null): MappedSong | null {
  if (!item?.videoId) return null
  const artistName = item.artists?.name || 'Desconocido'
  const artistId = item.artists?.artistId || item.artists?.id || null
  return {
    id: item.videoId,
    videoId: item.videoId,
    title: item.title || 'Sin título',
    artist: artistName,
    artistId,
    artists: [{ name: artistName, artistId }],
    album: null,
    albumArtUrl: bestThumb(item.thumbnails),
    source: 'youtube',
    duration: typeof item.duration === 'number' ? item.duration : 0,
  }
}

function mapArtist(artist?: RawArtist | null): { id: string; artistId: string; name: string | null; thumbUrl: string | null } | null {
  if (!artist?.artistId) return null
  return {
    id: artist.artistId,
    artistId: artist.artistId,
    name: artist.name ?? null,
    thumbUrl: bestThumb(artist.thumbnails),
  }
}

interface MappedAlbumBasic {
  id: string
  albumId: string
  title: string
  year: string | number | null
  thumbUrl: string | null
}

function mapAlbumBasic(album?: RawAlbumBasic | null): MappedAlbumBasic | null {
  const id = album?.albumId || album?.playlistId || album?.browseId || null
  if (!album || !id) return null
  return {
    id,
    albumId: id,
    title: album.name || album.title || 'Sin título',
    year: album.year ?? null,
    thumbUrl: bestThumb(album.thumbnails),
  }
}

interface MappedAlbumFull {
  id: string | null
  albumId: string | null
  title: string
  artist: string | null
  artistId: string | null
  year: string | number | null
  thumbUrl: string | null
  songs: MappedSong[]
}

function mapAlbumFull(album?: RawAlbumFull | null): MappedAlbumFull | null {
  if (!album) return null
  const artists = normalizeArtists(album)
  const id = album.albumId || album.playlistId || album.browseId || null
  return {
    id,
    albumId: id,
    title: album.name || album.title || 'Sin título',
    artist: artists.length ? artists.map((a) => a.name).join(', ') : null,
    artistId: artists[0]?.artistId || null,
    year: album.year ?? null,
    thumbUrl: bestThumb(album.thumbnails),
    songs: (album.songs || album.tracks || [])
      .map((raw) => {
        const song = mapSong(raw)
        if (!song) return null
        if (!song.artists?.length && artists.length) {
          song.artists = artists
          song.artist = artists.map((a) => a.name).join(', ')
          song.artistId = artists[0]?.artistId || null
        }
        song.album ??= album.name || album.title || null
        song.albumArtUrl ??= bestThumb(album.thumbnails)
        return song
      })
      .filter((s): s is MappedSong => s !== null),
  }
}

function mapPlaylistEntry(entry?: RawPlaylistEntry | null): { id: string; playlistId: string; title: string; author: string | null; thumbUrl: string | null; count: number | null } | null {
  const id = entry?.playlistId || entry?.albumId || entry?.browseId || null
  if (!entry || !id) return null
  return {
    id,
    playlistId: id,
    title: entry.name || entry.title || 'Sin título',
    author: entry.artist?.name || entry.channelName || entry.subtitle || null,
    thumbUrl: bestThumb(entry.thumbnails),
    count: entry.trackCount ?? null,
  }
}

// -----------------------------------------------------------------------
// getPlaylistVideos con recuperación por ítem.
//
// ytmusic-api asume que cada item de playlist trae thumbnails y accede a
// thumbnails[0].url sin chequear — un solo video privado/eliminado revienta
// la respuesta completa. Reimplementa el mismo request pero saltea los
// ítems que no se puedan parsear en vez de descartar la playlist entera.
// -----------------------------------------------------------------------

function traverse(data: unknown, ...keys: string[]): unknown {
  const walk = (node: unknown, key: string, isLastKey = false): unknown => {
    const found: unknown[] = []
    if (node instanceof Object && key in node) {
      found.push((node as Record<string, unknown>)[key])
      if (isLastKey) return found.length === 1 ? found[0] : found
    }
    if (Array.isArray(node)) {
      found.push(...node.map((child) => walk(child, key)).flat())
    } else if (node instanceof Object) {
      found.push(...Object.keys(node).map((k) => walk((node as Record<string, unknown>)[k], key)).flat())
    }
    return found.length === 1 ? found[0] : found
  }
  let value: unknown = data
  const lastKey = keys.at(-1)
  for (const key of keys) value = walk(value, key, lastKey === key)
  return value
}

function traverseList(data: unknown, ...keys: string[]): unknown[] {
  return [traverse(data, ...keys)].flat().filter((v) => v !== undefined)
}

function traverseString(data: unknown, ...keys: string[]): string {
  const v = traverseList(data, ...keys).at(0)
  return v == null ? '' : String(v)
}

function isTitleColumn(col: unknown): boolean {
  return traverseString(col, 'musicVideoType').startsWith('MUSIC_VIDEO_TYPE_')
}

function isArtistColumn(col: unknown): boolean {
  return ['MUSIC_PAGE_TYPE_USER_CHANNEL', 'MUSIC_PAGE_TYPE_ARTIST'].includes(traverseString(col, 'pageType'))
}

function isDurationColumn(col: unknown): boolean {
  return /(\d{1,2}:)?\d{1,2}:\d{1,2}/.test(traverseString(col, 'text'))
}

function parseDurationString(text: string): number | null {
  if (!text) return null
  const parts = text.split(':').map((n) => parseInt(n, 10))
  if (parts.some(Number.isNaN)) return null
  return parts.reduce((total, n) => total * 60 + n, 0)
}

interface ParsedPlaylistVideo {
  videoId: string
  name: string
  artist: { name: string; artistId: string | null }
  duration: number | null
  thumbnails: RawThumb[]
}

function parsePlaylistVideoSafe(item: unknown): ParsedPlaylistVideo | null {
  try {
    const flexColumns = traverseList(item, 'flexColumns', 'runs').flat()
    const fixedColumns = traverseList(item, 'fixedColumns', 'runs').flat()
    const title = flexColumns.find(isTitleColumn) || flexColumns[0]
    const artist = flexColumns.find(isArtistColumn) || flexColumns[1]
    const durationCol = fixedColumns.find(isDurationColumn)
    const thumbnails = traverseList(item, 'thumbnails') as RawThumb[]

    const directVideoId = traverseString(item, 'playNavigationEndpoint', 'videoId')
    const thumbUrl = thumbnails[0]?.url ?? ''
    const thumbMatch = thumbUrl.match(/https:\/\/i\.ytimg\.com\/vi\/(.+)\//)
    const videoId = directVideoId || thumbMatch?.[1]
    if (!videoId) return null

    return {
      videoId,
      name: traverseString(title, 'text'),
      artist: {
        name: traverseString(artist, 'text'),
        artistId: traverseString(artist, 'browseId') || null,
      },
      duration: parseDurationString(traverseString(durationCol, 'text')),
      thumbnails,
    }
  } catch {
    return null
  }
}

/** Acceso al request crudo de browse (constructRequest es private en la lib). */
type BrowseClient = {
  constructRequest: (
    endpoint: string,
    params?: Record<string, unknown>,
    additional?: Record<string, unknown>,
  ) => Promise<unknown>
}

async function getPlaylistVideosSafe(client: BrowseClient, playlistId: string): Promise<ParsedPlaylistVideo[]> {
  const browseId = playlistId.startsWith('PL') ? `VL${playlistId}` : playlistId
  const page = await client.constructRequest('browse', { browseId })
  const rawItems = traverseList(page, 'musicPlaylistShelfRenderer', 'musicResponsiveListItemRenderer')
  const songs = rawItems.map(parsePlaylistVideoSafe).filter((s): s is ParsedPlaylistVideo => s !== null)

  let continuation: unknown = traverse(page, 'continuation')
  if (Array.isArray(continuation)) continuation = continuation[0]

  let guard = 0
  while (!Array.isArray(continuation) && continuation && guard < 20) {
    guard += 1
    const nextPage = await client.constructRequest('browse', {}, { continuation })
    const nextItems = traverseList(nextPage, 'musicResponsiveListItemRenderer')
    songs.push(...nextItems.map(parsePlaylistVideoSafe).filter((s): s is ParsedPlaylistVideo => s !== null))
    continuation = traverse(nextPage, 'continuation')
    if (Array.isArray(continuation)) break
  }
  return songs
}

// -----------------------------------------------------------------------
// Operaciones expuestas por op=
// -----------------------------------------------------------------------

type QueryParams = Record<string, string>

class HttpError extends Error {
  status: number

  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

const operations: Record<string, (client: YTMusic, qs: QueryParams) => Promise<unknown>> = {
  async search(ytmusic, qs) {
    const q = String(qs.q || '').trim()
    if (!q) return []
    const limit = Math.min(parseInt(qs.limit || '25', 10) || 25, 50)
    const songs = (await ytmusic.searchSongs(q)) as unknown as RawSong[]
    return songs.slice(0, limit).map(mapSong).filter((s): s is MappedSong => s !== null)
  },

  async searchArtists(ytmusic, qs) {
    const q = String(qs.q || '').trim()
    if (!q) return []
    const limit = Math.min(parseInt(qs.limit || '12', 10) || 12, 30)
    const artists = (await ytmusic.searchArtists(q)) as unknown as RawArtist[]
    return artists.slice(0, limit).map(mapArtist).filter(Boolean)
  },

  async searchPlaylists(ytmusic, qs) {
    const q = String(qs.q || '').trim()
    if (!q) return []
    const limit = Math.min(parseInt(qs.limit || '12', 10) || 12, 30)
    // searchPlaylists puede no existir según la versión de la lib: cae a searchAlbums.
    const candidate = ytmusic as unknown as Record<string, unknown>
    const search = candidate.searchPlaylists ?? candidate.searchAlbums
    if (typeof search !== 'function') return []
    const raw = (await (search as (query: string) => Promise<RawPlaylistEntry[]>).call(ytmusic, q).catch(() => [])) || []
    return raw.slice(0, limit).map(mapPlaylistEntry).filter(Boolean)
  },

  async artist(ytmusic, qs) {
    const artistId = String(qs.artistId || '')
    if (!artistId) throw new HttpError(400, 'Missing artistId')
    // Discografía desde getArtist(): su respuesta (ArtistFull) ya incluye
    // topAlbums/topSingles parseados de la MISMA llamada browse. Antes se
    // usaba ytmusic-api.getArtistAlbums(), que agarra musicCarouselShelfRenderer[0]
    // sin importar cuál carrusel sea — mostraba mixes/playlists ajenas al
    // artista. Y antes de eso un helper propio re-browseaba el artista para
    // traer las listas COMPLETAS: correcto pero lento (3 browses extra en
    // serie). El preview del shelf (~10 ítems) es lo mismo que muestra YT
    // Music web por fila; la velocidad acá gana.
    const [info, songs] = await Promise.all([
      ytmusic.getArtist(artistId).catch(() => null),
      (ytmusic as unknown as { getArtistSongs?: (id: string) => Promise<RawSong[]> }).getArtistSongs?.(artistId).catch(() => []) ?? [],
    ])
    const infoRaw = info as unknown as RawArtist | null
    return {
      id: artistId,
      name: infoRaw?.name || null,
      thumbUrl: bestThumb(infoRaw?.thumbnails),
      // "About" del canal de YT Music, cuando existe — se usa como fuente principal de
      // biografía en la página de artista (con Wikipedia/AudioDB como respaldo), en vez
      // de depender siempre de esas 2 APIs externas en paralelo.
      description: infoRaw?.description || null,
      songs: (songs || []).slice(0, 20).map(mapSong).filter((s): s is MappedSong => s !== null),
      albums: (infoRaw?.topAlbums || []).map(mapAlbumBasic).filter(Boolean),
      singles: (infoRaw?.topSingles || []).map(mapAlbumBasic).filter(Boolean),
    }
  },

  async album(ytmusic, qs) {
    const albumId = String(qs.albumId || '')
    if (!albumId) throw new HttpError(400, 'Missing albumId')
    const raw =
      typeof ytmusic.getAlbum === 'function'
        ? ((await ytmusic.getAlbum(albumId).catch(() => null)) as unknown as RawAlbumFull | null)
        : null
    return mapAlbumFull(raw) || { id: albumId, albumId, title: null, songs: [] }
  },

  async playlist(ytmusic, qs) {
    const playlistId = String(qs.playlistId || '')
    if (!playlistId) throw new HttpError(400, 'Missing playlistId')

    let raw: RawPlaylistFull | null = null
    let videos: ParsedPlaylistVideo[] = []
    if (typeof ytmusic.getPlaylist === 'function') {
      const [meta, safeVideos] = await Promise.all([
        ytmusic.getPlaylist(playlistId).catch(() => null) as Promise<RawPlaylistFull | null>,
        getPlaylistVideosSafe(ytmusic as unknown as BrowseClient, playlistId).catch(() => []),
      ])
      raw = meta
      videos = safeVideos || []
    }
    if (!raw && typeof ytmusic.getAlbum === 'function') {
      raw = (await ytmusic.getAlbum(playlistId).catch(() => null)) as unknown as RawPlaylistFull | null
    }
    if (!raw) throw new HttpError(404, 'Playlist not found')

    const sources = videos.length ? videos : raw.songs || raw.tracks || raw.videos || []
    const songs = (sources as RawSong[]).map(mapSong).filter((s): s is MappedSong => s !== null)

    return {
      id: playlistId,
      title: raw.name || raw.title || 'Playlist importada',
      author: raw.artist?.name || raw.channelName || null,
      thumbUrl: bestThumb(raw.thumbnails),
      songs,
    }
  },

  async song(ytmusic, qs) {
    const videoId = String(qs.videoId || '')
    if (!videoId) throw new HttpError(400, 'Missing videoId')
    const raw = (await ytmusic.getSong(videoId).catch(() => null)) as unknown as RawSong | null
    if (!raw) throw new HttpError(404, 'Song not found')
    return mapSong(raw)
  },

  // "Radio"/relacionados de una canción — el mismo grafo que usa YT Music
  // para su propio autoplay. Es la pieza que le faltaba a la app para tener
  // un motor de recomendación real (Spotify canceló sus endpoints públicos
  // de Recommendations/Related Artists para apps nuevas en nov. 2024, así
  // que no hay alternativa viable ahí): se usa tanto para extender la cola
  // en autoplay como para el Smart Shuffle.
  async related(ytmusic, qs) {
    const videoId = String(qs.videoId || '')
    if (!videoId) throw new HttpError(400, 'Missing videoId')
    const limit = Math.min(parseInt(qs.limit || '10', 10) || 10, 25)
    const raw = (await ytmusic.getUpNexts(videoId).catch(() => [])) as unknown as RawUpNext[]
    return (raw || []).slice(0, limit).map(mapUpNext).filter((s): s is MappedSong => s !== null)
  },

  async lyrics(ytmusic, qs) {
    const videoId = String(qs.videoId || '')
    if (!videoId) throw new HttpError(400, 'Missing videoId')
    const lines = await ytmusic.getLyrics(videoId).catch(() => null)
    return { lines: lines || null }
  },

  async trending(ytmusic, qs) {
    const limit = Math.min(parseInt(qs.limit || '24', 10) || 24, 50)
    const songs = (await ytmusic.searchSongs('top hits 2026')) as unknown as RawSong[]
    return songs.slice(0, limit).map(mapSong).filter((s): s is MappedSong => s !== null)
  },

  // Resuelve una playlist pública de Spotify (link/URI/ID) a metadata +
  // temas crudos. Vive acá adentro (en vez de en su propia función
  // serverless) porque el plan Hobby de Vercel tiene un tope de 12
  // funciones y este proyecto ya estaba en el límite — no necesita el
  // cliente `ytmusic`, así que el handler se lo salta para este op.
  async spotifyPlaylist(_ytmusic, qs) {
    const raw = String(qs.url || qs.playlistId || '')
    if (!raw) throw new HttpError(400, 'Missing url')
    try {
      return await resolveSpotifyPlaylist(raw)
    } catch (err) {
      if (err instanceof SpotifyError) throw new HttpError(err.status, err.message)
      throw err
    }
  },
}

/** Normaliza req.query (valores string|string[]) a un plano string→string. */
function flatQuery(query: VercelRequest['query']): QueryParams {
  const out: QueryParams = {}
  for (const [key, value] of Object.entries(query || {})) {
    out[key] = Array.isArray(value) ? value.join(',') : value ?? ''
  }
  return out
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<VercelResponse | void> {
  res.setHeader('Access-Control-Allow-Origin', '*')

  const limit = await checkRateLimit(`ytmusic:${clientIp(req)}`, YTMUSIC_LIMIT.max, YTMUSIC_LIMIT.windowMs)
  if (!limit.allowed) {
    res.setHeader('Retry-After', String(limit.retryAfterSeconds))
    return res.status(429).json({ error: 'Demasiadas solicitudes, esperá un poco' })
  }

  const qs = flatQuery(req.query)
  const op = qs.op || 'search'
  const run = operations[op]
  if (!run) {
    return res.status(400).json({ error: 'Unknown op' })
  }

  const cacheKey = `${op}:${new URLSearchParams(qs).toString()}`
  const cached = getCached(cacheKey)
  if (cached) return res.status(200).json(cached)

  try {
    // spotifyPlaylist no necesita el cliente de ytmusic-api — evitamos
    // pagar su inicialización (potencialmente lenta o fallida) para algo
    // que no la usa.
    const ytmusic = op === 'spotifyPlaylist' ? (null as unknown as YTMusic) : await getClient()
    const data = await run(ytmusic, qs)

    const isEmptyPlaylist =
      (op === 'playlist' &&
        Array.isArray((data as { songs?: unknown[] } | null)?.songs) &&
        (data as { songs: unknown[] }).songs.length === 0) ||
      (op === 'spotifyPlaylist' &&
        Array.isArray((data as { tracks?: unknown[] } | null)?.tracks) &&
        (data as { tracks: unknown[] }).tracks.length === 0)
    if (!isEmptyPlaylist) setCached(cacheKey, data)

    return res.status(200).json(data)
  } catch (err) {
    if (err instanceof HttpError) {
      return res.status(err.status).json({ error: err.message })
    }
    console.warn(`[ytmusic] Error (op=${op}):`, String(err instanceof Error ? err.message : err).slice(0, 300))
    return res.status(500).json({
      error: 'Internal error',
      detail: String(err instanceof Error ? err.message : err).slice(0, 200),
    })
  }
}
