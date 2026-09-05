/**
 * Detección de lanzamientos server-side (espejo de la lógica de
 * src/shared/lib/releaseWatch.ts pero para el runtime del cron, donde NO
 * existe localStorage ni el proxy /api/itunes — iTunes se consulta directo,
 * que en server no tiene problema de CORS).
 *
 * Se mantiene independiente a propósito: el bundle del cron es otro mundo
 * (Node puro vía @vercel/node) y compartir módulos con src/ arrastraría
 * sonner/DOM al server. La lógica es pequeña y estable.
 */

const ARTIST_CHECK_GAP_MS = 12 * 60 * 60 * 1000

export interface ITunesReleaseItem {
  wrapperType?: string
  artistId?: number
  artistName?: string
  collectionName?: string
  trackName?: string
  releaseDate?: string
}

export function normName(s: unknown): string {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

async function itunesSearch(entity: 'album' | 'song', term: string, limit: number): Promise<ITunesReleaseItem[]> {
  const url = `https://itunes.apple.com/search?term=${encodeURIComponent(term)}&entity=${entity}&limit=${limit}`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`iTunes ${res.status}`)
  const data = (await res.json()) as { results?: ITunesReleaseItem[] }
  return data.results ?? []
}

/** El item más nuevo cuyo artista coincide (evita robar releases de homónimos). */
function newestForArtist(items: ITunesReleaseItem[], artistKey: string): { ms: number; label: string } | null {
  let best: { ms: number; label: string } | null = null
  for (const it of items) {
    if (!it.releaseDate || !it.artistName) continue
    const n = normName(it.artistName)
    if (!(n === artistKey || n.includes(artistKey) || artistKey.includes(n))) continue
    const ms = Date.parse(it.releaseDate)
    if (!Number.isFinite(ms)) continue
    if (!best || ms > best.ms) best = { ms, label: it.collectionName || it.trackName || '' }
  }
  return best
}

export interface ReleaseCheckResult {
  /** Hay baseline previa Y algo nuevo: hay que notificar. */
  notify: boolean
  title?: string
  body?: string
  nextArtist: WatchedArtistInput & { lastAlbumMs?: number; lastSongMs?: number; lastCheckAt: number }
}

interface WatchedArtistInput {
  key: string
  name: string
  lastAlbumMs?: number
  lastSongMs?: number
  lastCheckAt?: number
}

/**
 * Consulta iTunes por un artista y compara contra el snapshot guardado.
 * Mismas reglas anti-spam del cliente: sin baseline → solo actualiza snapshot.
 */
export async function checkArtistReleases(artist: WatchedArtistInput): Promise<ReleaseCheckResult> {
  const base = { key: artist.key, name: artist.name }
  if (artist.lastCheckAt && Date.now() - artist.lastCheckAt < ARTIST_CHECK_GAP_MS) {
    return { notify: false, nextArtist: { ...base, ...pickSnapshots(artist), lastCheckAt: artist.lastCheckAt } }
  }

  const [albums, songs] = await Promise.all([
    itunesSearch('album', artist.name, 12),
    itunesSearch('song', artist.name, 25),
  ])
  const albumInfo = newestForArtist(albums, artist.key)
  const songInfo = newestForArtist(songs, artist.key)

  const latest = {
    albumMs: albumInfo?.ms ?? artist.lastAlbumMs ?? 0,
    songMs: songInfo?.ms ?? artist.lastSongMs ?? 0,
  }

  // Sin resultados útiles igual marcamos el chequeo (no reintentar en loop).
  const nextArtist = {
    ...base,
    lastAlbumMs: latest.albumMs || artist.lastAlbumMs,
    lastSongMs: latest.songMs || artist.lastSongMs,
    lastCheckAt: Date.now(),
  }

  const hadBaseline = artist.lastAlbumMs !== undefined || artist.lastSongMs !== undefined
  if (!hadBaseline) return { notify: false, nextArtist }

  const parts: string[] = []
  if (latest.albumMs > (artist.lastAlbumMs ?? 0) && albumInfo?.label) parts.push(`Álbum: “${albumInfo.label}”`)
  else if (latest.songMs > (artist.lastSongMs ?? 0) && songInfo?.label) parts.push(`Canción: “${songInfo.label}”`)
  if (parts.length === 0) return { notify: false, nextArtist }

  return {
    notify: true,
    title: `Nuevo lanzamiento de ${artist.name}`,
    body: parts.join(' · '),
    nextArtist,
  }
}

function pickSnapshots(a: WatchedArtistInput): { lastAlbumMs?: number; lastSongMs?: number } {
  return { lastAlbumMs: a.lastAlbumMs, lastSongMs: a.lastSongMs }
}
