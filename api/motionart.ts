/**
 * Motion Art API — Apple Music animated album cover (HLS .m3u8 stream).
 *
 * Estrategia de búsqueda (de más precisa a menos):
 * 1. Resolver el ARTIST ID exacto en iTunes y pedirle su catálogo completo
 *    (endpoint /lookup, no /search) → buscar el título ahí dentro. Esto NO
 *    depende del ranking de relevancia de iTunes: no importa qué tan
 *    popular sea una canción de OTRO artista con el mismo título, porque
 *    ni siquiera aparece en la respuesta — solo vienen canciones/álbumes
 *    que pertenecen realmente a ese artistId.
 * 2. Si no se pudo resolver el artistId (nombre ambiguo, typo, etc.),
 *    respaldo con /search de texto libre, pero SIEMPRE filtrando por
 *    coincidencia de artista antes de aceptar un resultado — nunca se usa
 *    la canción de un artista distinto como respaldo.
 * 3. Si nada, devolver { url: null } para que el fondo estático tome el
 *    relevo.
 *
 * Parámetros de query:
 *   title  — título de la canción (preferido para localizar la colección)
 *   album  — nombre del álbum   (fallback)
 *   artist — nombre del artista (requerido)
 */

import type { VercelRequest, VercelResponse } from '@vercel/node'

export const config = { maxDuration: 20 }

interface MotionArtResult {
  url: string | null
}

const CACHE = new Map<string, { time: number; data: MotionArtResult }>()
const CACHE_TTL = 1000 * 60 * 60 * 24 // 24 h

// Requests idénticos EN VUELO comparten la misma promesa: el frontend pide
// /api/motionart DOS veces por canción (portada + fondo) con los mismos
// params y en el mismo milisegundo — sin esto, ambas MISS y cada una paga
// el scrape completo de Apple Music (hasta 6 fetches escalonados), duplicando
// invocaciones, latencia y riesgo de bloqueo por rate-limit.
const inflight = new Map<string, Promise<MotionArtResult>>()

// Circuit breaker compartido entre invocaciones "tibias" del mismo
// lambda: si Apple devuelve 403/429, dejamos de pedirle nada por un
// rato en vez de seguir insistiendo y empeorar el bloqueo.
let blockedUntil = 0
const REQUEST_SPACING_MS = 120 // espaciado mínimo entre fetches a Apple dentro de una misma invocación
const BACKOFF_ON_BLOCK_MS = 30_000

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** Ejecuta las tareas de a una, con espaciado mínimo, y corta apenas una devuelve resultado. */
async function runStaggeredUntilFound(tasks: (() => Promise<string | null>)[]): Promise<string | null> {
  for (const task of tasks) {
    if (Date.now() < blockedUntil) continue
    const result = await task()
    if (result) return result
    await sleep(REQUEST_SPACING_MS)
  }
  return null
}

const AM_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9',
}

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

/** Registro relevante de la iTunes Search/Lookup API. */
interface ITunesResult {
  wrapperType?: string
  artistId?: number
  artistName?: string
  trackName?: string
  collectionName?: string
  collectionId?: number
}

/** Extrae la primera URL .m3u8 de Motion Art de la página HTML de Apple Music. */
async function fetchM3u8FromCollectionId(collectionId: number): Promise<string | null> {
  const url = `https://music.apple.com/us/album/${collectionId}`
  let html: string
  try {
    const res = await fetch(url, { headers: AM_HEADERS })
    if (!res.ok) return null
    html = await res.text()
  } catch {
    return null
  }

  const matches = Array.from(html.matchAll(/https:\/\/mvod\.itunes\.apple\.com\/[^"'\s]+\.m3u8/g))
    .map((m) => m[0])
  const unique = [...new Set(matches)]
  return unique[0] ?? null
}

async function itunesRequest(url: string): Promise<ITunesResult[]> {
  if (Date.now() < blockedUntil) return []
  try {
    const res = await fetch(url)
    if (res.status === 403 || res.status === 429) {
      blockedUntil = Date.now() + BACKOFF_ON_BLOCK_MS
      return []
    }
    if (!res.ok) return []
    const data = (await res.json()) as { results?: ITunesResult[] }
    return data.results ?? []
  } catch {
    return []
  }
}

/** Llama a iTunes Search API (texto libre, ordenado por relevancia) y devuelve los resultados. */
async function itunesSearch(term: string, entity: string, limit = 10): Promise<ITunesResult[]> {
  const url =
    `https://itunes.apple.com/search?` +
    `term=${encodeURIComponent(term)}&entity=${entity}&limit=${limit}`
  return itunesRequest(url)
}

/**
 * Llama a iTunes Lookup API: devuelve el catálogo REAL de un artistId
 * específico (no una búsqueda de texto relevancia-ordenada). El primer
 * elemento del array es siempre el propio artista (wrapperType "artist"),
 * seguido de sus canciones/álbumes — nada de otros artistas se cuela acá.
 */
async function itunesLookupArtistCatalog(artistId: number, entity: string, limit = 200): Promise<ITunesResult[]> {
  const url =
    `https://itunes.apple.com/lookup?` +
    `id=${encodeURIComponent(artistId)}&entity=${entity}&limit=${limit}`
  const all = await itunesRequest(url)
  const wrapperType = entity === 'album' ? 'collection' : 'track'
  return all.filter((r) => r.wrapperType === wrapperType)
}

/** Sanitiza texto para comparación tolerante. */
function normalize(str = ''): string {
  return str
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // quitar tildes
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Resuelve el artistId exacto de iTunes para un nombre de artista dado,
 * buscando en la entidad "musicArtist" (no canciones/álbumes, así el
 * ranking de popularidad de canciones no interfiere para nada acá).
 * Solo acepta el resultado si el nombre calza de forma inequívoca —
 * evita agarrar el ID de un artista homónimo distinto.
 */
async function resolveArtistId(name: string): Promise<number | null> {
  const candidates = await itunesSearch(name, 'musicArtist', 5)
  if (!candidates.length) return null

  const normName = normalize(name)

  // 1) Coincidencia exacta de nombre — la preferida siempre.
  const exact = candidates.find((c) => normalize(c.artistName) === normName)
  if (exact?.artistId) return exact.artistId

  // 2) Si ningún candidato calza exacto, solo aceptamos un match parcial
  //    cuando es INEQUÍVOCO (un único candidato lo cumple). Si hay más de
  //    uno, es mejor no adivinar y dejar que el respaldo por texto libre
  //    (con su propio filtro de artista) se encargue.
  const partial = candidates.filter((c) => {
    const na = normalize(c.artistName)
    return na.includes(normName) || normName.includes(na)
  })
  if (partial.length !== 1) return null
  return partial[0]?.artistId ?? null
}

/** True si el nombre de artista de un resultado de iTunes corresponde al artista buscado. */
function makeArtistMatcher(primaryArtist: string): (item: ITunesResult) => boolean {
  const normArtist = normalize(primaryArtist)
  return (item) => {
    const na = normalize(item.artistName)
    return na.includes(normArtist) || normArtist.includes(na)
  }
}

// ------------------------------------------------------------------
// Handler
// ------------------------------------------------------------------

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<VercelResponse | void> {
  const { title, album, artist } = req.query

  if (!artist) {
    return res.status(400).json({ error: 'Missing ?artist param' })
  }
  const artistName = Array.isArray(artist) ? artist.join(',') : artist

  const titleName = Array.isArray(title) ? title.join(',') : title
  const albumName = Array.isArray(album) ? album.join(',') : album

  const cacheKey = `ma:${normalize(titleName)}:${normalize(albumName)}:${normalize(artistName)}`
  const cached = CACHE.get(cacheKey)
  if (cached && Date.now() - cached.time < CACHE_TTL) {
    res.setHeader('Cache-Control', 'public, max-age=86400')
    return res.status(200).json(cached.data)
  }

  // Dedupe de vuelo: segunda request idéntica espera la primera.
  const pending = inflight.get(cacheKey)
  if (pending) {
    res.setHeader('Cache-Control', 'public, max-age=86400')
    return res.status(200).json(await pending)
  }

  const job = resolveMotionArt({ title: titleName || '', album: albumName || '', artist: artistName })
    .finally(() => {
      inflight.delete(cacheKey)
    })
  inflight.set(cacheKey, job)

  const result = await job
  CACHE.set(cacheKey, { time: Date.now(), data: result })
  res.setHeader('Cache-Control', 'public, max-age=86400')
  return res.status(200).json(result)
}

/** Toda la lógica de búsqueda — separada del handler para poder dedupearla. */
async function resolveMotionArt({ title, album, artist }: { title: string; album: string; artist: string }): Promise<MotionArtResult> {
  // Extraer el artista principal (antes de "feat.", "&", etc.)
  const primaryArtist = artist.split(/,|\s*&\s*|\s+feat\.?\s+|\s+ft\.?\s+/i)[0]?.trim() || artist
  const artistMatches = makeArtistMatcher(primaryArtist)
  const normTitle = normalize(title || '')
  const normAlbumHint = normalize(album || '')
  const normAlbum = normalize(album || '')

  const triedCollectionIds = new Set<number>()
  let m3u8Url: string | null = null

  // Resolver el artistId una sola vez; ambas estrategias lo reutilizan.
  const artistId = await resolveArtistId(primaryArtist)

  // ------------------------------------------------------------------
  // Estrategia 1: buscar POR CANCIÓN → collectionId exacto
  // ------------------------------------------------------------------
  if (title && !m3u8Url) {
    let candidates: ITunesResult[] = []

    // 1a) Camino robusto: catálogo real del artistId resuelto.
    if (artistId) {
      const catalog = await itunesLookupArtistCatalog(artistId, 'song', 200)
      candidates = catalog.filter((s) => {
        const nt = normalize(s.trackName)
        return nt === normTitle || nt.includes(normTitle) || normTitle.includes(nt)
      })
    }

    // 1b) Respaldo: no se pudo resolver el artistId (nombre ambiguo o con
    // typo) o el catálogo lookup no trajo la canción (raro, pero por si
    // el trackName difiere bastante). Buscamos por texto libre, pero
    // siempre filtrando estrictamente por artista antes de aceptar nada
    // — nunca se acepta la canción de otro artista, sin importar qué tan
    // popular sea.
    if (!candidates.length) {
      const songs = await itunesSearch(`${title} ${primaryArtist}`, 'song', 25)
      let byArtist = songs.filter(artistMatches)
      if (!byArtist.length) {
        const broader = await itunesSearch(title, 'song', 50)
        byArtist = broader.filter(artistMatches)
      }
      candidates = byArtist
    }

    // Ordenar: primero los que coinciden mejor con título exacto + álbum.
    candidates.sort((a, b) => {
      const score = (s: ITunesResult): number =>
        (normalize(s.trackName) === normTitle ? 3 : 0) +
        (normAlbumHint && normalize(s.collectionName) === normAlbumHint ? 2 : 0)
      return score(b) - score(a)
    })

    // Seleccionar los 6 mejores collectionIds únicos
    const bestIds: number[] = []
    for (const song of candidates) {
      if (song.collectionId && !triedCollectionIds.has(song.collectionId)) {
        triedCollectionIds.add(song.collectionId)
        bestIds.push(song.collectionId)
        if (bestIds.length >= 6) break
      }
    }

    // Escalonado, no en paralelo: 6 fetches simultáneos a music.apple.com
    // es lo que disparaba bloqueos. Corta apenas encuentra un .m3u8 válido.
    const tasks = bestIds.map((id) => () => fetchM3u8FromCollectionId(id))
    m3u8Url = await runStaggeredUntilFound(tasks)
  }

  // ------------------------------------------------------------------
  // Estrategia 2: buscar POR ÁLBUM → collectionId
  // ------------------------------------------------------------------
  if (!m3u8Url && album) {
    let albumCandidates: ITunesResult[] = []

    // 2a) Camino robusto: álbumes reales del artistId resuelto.
    if (artistId) {
      const catalog = await itunesLookupArtistCatalog(artistId, 'album', 200)
      albumCandidates = catalog.filter((a) => {
        const na = normalize(a.collectionName)
        return na === normAlbum || na.includes(normAlbum) || normAlbum.includes(na)
      })
    }

    // 2b) Respaldo por texto libre, con el mismo filtro estricto de artista.
    if (!albumCandidates.length) {
      const albums = await itunesSearch(`${album} ${primaryArtist}`, 'album', 15)
      let byArtist = albums.filter(artistMatches)
      if (!byArtist.length) {
        const broader = await itunesSearch(album, 'album', 30)
        byArtist = broader.filter(artistMatches)
      }
      albumCandidates = byArtist
    }

    // Prefer exact album name match
    albumCandidates.sort((a, b) => {
      const aExact = normalize(a.collectionName) === normAlbum ? 1 : 0
      const bExact = normalize(b.collectionName) === normAlbum ? 1 : 0
      return bExact - aExact
    })

    const bestIds: number[] = []
    for (const alb of albumCandidates) {
      if (alb.collectionId && !triedCollectionIds.has(alb.collectionId)) {
        triedCollectionIds.add(alb.collectionId)
        bestIds.push(alb.collectionId)
        if (bestIds.length >= 4) break
      }
    }

    const tasks = bestIds.map((id) => () => fetchM3u8FromCollectionId(id))
    m3u8Url = await runStaggeredUntilFound(tasks)
  }

  // ------------------------------------------------------------------
  // Resultado (el caché y la respuesta HTTP los maneja el handler)
  // ------------------------------------------------------------------
  return { url: m3u8Url }
}
