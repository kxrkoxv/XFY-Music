/** Wikipedia API client for fetching high-quality artist biographies and thumbnails. Supports cross-origin requests directly. */
import { fetchJsonRobust } from '@shared/lib/httpClient'
import type { WikipediaBio } from '@/types/models'

// Bump when the matching/scoring logic below changes, to invalidate
// entries cached under the old (possibly wrong) logic.
const CACHE_KEY = 'xfy_wikipedia_cache_v6'
const CACHE_TTL_MS = 1000 * 60 * 60 * 24 * 30 // 30 días

interface WikiSummary {
  type?: string
  title?: string
  extract?: string
  description?: string
  thumbnail?: { source?: string }
  content_urls?: { desktop?: { page?: string } }
}

type BioCache = Record<string, { value: WikipediaBio | null; fetchedAt: number }>

function readCache(): BioCache {
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    return raw ? (JSON.parse(raw) as BioCache) : {}
  } catch {
    return {}
  }
}

function writeCache(cache: BioCache): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(cache))
  } catch {
    // localStorage unavailable — non-critical
  }
}

function cacheKeyFor(name: string | null | undefined): string {
  return String(name).toLowerCase().trim()
}

/** Normalizes text for tolerant comparison: lowercase, no accents/punctuation. */
function normalize(str = ''): string {
  return str
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\(.*?\)/g, ' ') // strip parenthetical disambiguators, e.g. "(cantante)"
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Checks whether a page title plausibly refers to the searched name, so a
 * loosely-related full-text search hit (e.g. "Dowba Montana" -> "El Alfa")
 * isn't accepted just because it ranked first.
 */
function isLikelyMatch(query: string, pageTitle: string): boolean {
  const nq = normalize(query)
  const nt = normalize(pageTitle)
  if (!nq || !nt) return false
  if (nq === nt) return true

  const qWords = nq.split(' ').filter(Boolean)
  const tWords = new Set(nt.split(' ').filter(Boolean))

  // Every "meaningful" word (>2 letters, skips connectors like "el"/"de")
  // must appear in the page title.
  const meaningful = qWords.filter((w) => w.length > 2)
  const relevant = meaningful.length ? meaningful : qWords
  return relevant.every((w) => tWords.has(w))
}

// Timeout corto y sin reintentos, por la misma razón que en audiodb.js:
// esto se pide en paralelo con varias otras fuentes (varios candidatos ×
// varios idiomas), cada llamador ya hace .catch(() => null), y antes un
// fetch() colgado sin timeout dejaba `bioLoading` en true para siempre —
// la sección de biografía se quedaba en skeleton eterno en vez de caer al
// mensaje de "no tenemos biografía".
async function fetchJson<T = unknown>(url: string): Promise<T> {
  return fetchJsonRobust(url, { timeoutMs: 8000, retries: 0 })
}

// A matching title isn't enough on its own: an unrelated namesake from
// another domain (mythology, comics, sports, etc.) can share the exact
// same page title as the artist (e.g. "Laufey" the singer vs. "Laufey"
// the Norse mythological figure). These keywords, checked against the
// page's description/extract, flag that case so it gets rejected outright.
const NON_MUSIC_KEYWORDS = [
  'mitología', 'mitológic', 'mythology', 'mythological', 'diosa', 'dios ', 'deity', 'deidad',
  'giganta', 'gigante', 'jötunn', 'folclore', 'folklore', 'legendary figure', 'leyenda',
  'personaje de ficción', 'personaje ficticio', 'fictional character', 'ficción', 'cómic', 'comics',
  'marvel', 'dc comics', 'videojuego', 'video game character', 'anime', 'manga',
  'futbolista', 'football player', 'jugador de fútbol', 'jugadora de fútbol', 'atleta',
  'bióloga', 'biólogo', 'biologist', 'política', 'político', 'politician', 'activista', 'activist',
  'actriz', 'actor de cine', 'escritora', 'escritor', 'novelista', 'pintor', 'pintora', 'santo', 'santa católica',
]

const MUSIC_KEYWORDS = [
  'cantante', 'cantautor', 'cantautora', 'músico', 'música islandesa', 'compositor', 'compositora',
  'banda', 'grupo musical', 'rapero', 'rapera', 'dj ', 'multiinstrumentista',
  'singer', 'songwriter', 'musician', 'band', 'rapper', 'composer', 'record producer',
]

function containsAny(text: string, list: string[]): boolean {
  const n = normalize(text)
  return list.some((kw) => n.includes(normalize(kw ?? "")))
}

/**
 * Scores how likely a Wikipedia result describes the searched MUSIC
 * ARTIST rather than an unrelated namesake, using its short description
 * and extract. Returns null when the result should be discarded outright.
 */
function scoreMusicCandidate(summary: WikiSummary): number | null {
  const text = `${summary?.description || ''} ${summary?.extract || ''}`
  if (containsAny(text, NON_MUSIC_KEYWORDS)) return null
  return containsAny(text, MUSIC_KEYWORDS) ? 2 : 0
}

/** Requests a higher-resolution (1000px) thumbnail from Wikimedia's resize servers. */
function upscaleWikiThumb(url: string | null | undefined): string | null | undefined {
  if (!url) return url
  if (/upload\.wikimedia\.org\/.+\/thumb\//.test(url)) {
    return url.replace(/\/\d+px-([^/]+)$/, '/1000px-$1')
  }
  return url
}

/** Fetches and validates the summary for a single candidate page title. */
async function fetchCandidateSummary(name: string, lang: string, title: string): Promise<WikiSummary | null> {
  if (!isLikelyMatch(name, title)) return null

  const summaryUrl = `https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`
  const summary = await fetchJson<WikiSummary>(summaryUrl).catch(() => null)
  if (!summary) return null
  if (summary?.type === 'disambiguation' || !summary?.extract) return null

  // The summary's canonical title can differ from the search title via a
  // redirect — re-validate the match against it too.
  if (summary?.title && !isLikelyMatch(name, summary.title)) return null

  return summary
}

/** Searches for an artist's summary in a specific Wikipedia language edition. */
async function lookupInLang(name: string, lang: string): Promise<WikipediaBio | null> {
  // Fetch several candidates, not just the top hit: a same-titled
  // namesake from another domain needs to be scored and discarded, not
  // just the first result blindly accepted.
  const searchUrl = `https://${lang}.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(
    name,
  )}&format=json&origin=*&srlimit=5`
  const searchResult = await fetchJson<{ query?: { search?: { title?: string }[] } }>(searchUrl)
  const titles = (searchResult?.query?.search || []).map((r) => r.title).filter((t): t is string => Boolean(t))
  if (!titles.length) return null

  const candidates = (
    await Promise.all(titles.map((title) => fetchCandidateSummary(name, lang, title).catch(() => null)))
  ).filter((c): c is WikiSummary => Boolean(c))
  if (!candidates.length) return null

  let best = null
  let bestScore = -Infinity
  for (const candidate of candidates) {
    const score = scoreMusicCandidate(candidate)
    if (score === null) continue
    if (score > bestScore) {
      best = candidate
      bestScore = score
    }
  }
  if (!best) return null

  return {
    summary: best.extract,
    thumb: upscaleWikiThumb(best.thumbnail?.source) || null,
    wikipediaUrl: best.content_urls?.desktop?.page || null,
  }
}

/**
 * Traduce un texto largo al español usando MyMemory (gratuita, sin API
 * key, con CORS habilitado). Se usa solo como último recurso, cuando
 * Wikipedia no tiene artículo en español para el artista: mostrar la bio
 * en inglés tal cual quedaba inconsistente con el resto de la app, que
 * está en español. Si la traducción falla por cualquier motivo, se
 * devuelve el texto original en inglés en vez de perder la bio.
 */
async function translateToSpanish(text: string | null | undefined): Promise<string | null | undefined> {
  if (!text) return text
  // MyMemory limita ~500 caracteres por pedido en el tier gratuito.
  const chunk = text.length > 480 ? `${text.slice(0, 480)}…` : text
  try {
    const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(chunk)}&langpair=en|es`
    const json = await fetchJson<{ responseData?: { translatedText?: string } }>(url)
    const translated = json?.responseData?.translatedText
    // MyMemory a veces devuelve el mismo texto sin traducir cuando falla
    // internamente, o un mensaje de cuota agotada en vez de una traducción.
    if (!translated || /MYMEMORY WARNING/i.test(translated)) return text
    return translated
  } catch {
    return text
  }
}

/**
 * Fetches the Wikipedia biography for an artist.
 * Attempts the Spanish ('es') edition first, falling back to English ('en')
 * translated to Spanish so the whole app stays in one language.
 */
export async function lookupArtistBio(name: string | null | undefined): Promise<WikipediaBio | null> {
  if (!name) return null

  const key = cacheKeyFor(name)
  const cache = readCache()
  const cached = cache[key]
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached.value

  try {
    const esResult = await lookupInLang(name, 'es').catch(() => null)
    let value = esResult
    if (!value) {
      const enResult = await lookupInLang(name, 'en').catch(() => null)
      if (enResult) {
        value = {
          ...enResult,
          summary: await translateToSpanish(enResult.summary ?? null),
          translated: true,
        }
      }
    }
    cache[key] = { value, fetchedAt: Date.now() }
    writeCache(cache)
    return value
  } catch (e) {
    console.warn('[XFY] Wikipedia lookup de artista falló')
    return null
  }
}

/**
 * Bio/summary de un ÁLBUM para su página de detalle — misma filosofía de
 * datos reales que lookupArtistBio: solo se acepta un artículo cuyo título
 * coincida estrictamente con el título del álbum Y cuya descripción hable
 * efectivamente del álbum (menciona al artista, o es un "álbum"/"EP"/"disco").
 * Si nada cumple, devuelve null — preferimos no mostrar info a mostrar una
 * equivocada.
 */
async function fetchAlbumCandidateSummary(title: string, artist: string, lang: string, pageTitle: string): Promise<WikiSummary | null> {
  // El artículo debe ser DEL ÁLBUM: sus palabras significativas tienen que
  // estar en el título de la página ("Hit Me Hard and Soft", "Dont Smile at Me").
  if (!isLikelyMatch(title, pageTitle)) return null

  const summaryUrl = `https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(pageTitle)}`
  const summary = await fetchJson<WikiSummary>(summaryUrl).catch(() => null)
  if (!summary) return null
  if (summary?.type === 'disambiguation' || !summary?.extract) return null

  // Revalidar también el título canónico (puede venir por redirect).
  if (summary?.title && !isLikelyMatch(title, summary.title)) return null

  const text = `${summary?.description || ''} ${summary?.extract || ''}`
  const nArtist = normalize(artist || '')
  // ¿Hábla del álbum correcto? Menciona al artista, o se autodescribe como
  // álbum/EP/disco/mixtape. Un homónimo de otro ámbito (una canción, una
  // película) queda descartado en vez de colarse.
  const mentionsArtist = nArtist ? containsAny(text, [nArtist]) : false
  const isAboutAnAlbum = /\b(album|álbum|ep\b|mixtape|disco)\b/i.test(text)
  if (!mentionsArtist && !isAboutAnAlbum) return null

  return summary
}

/** Busca el resumen de un álbum en una edición específica de Wikipedia. */
async function lookupAlbumInLang(title: string, artist: string, lang: string): Promise<WikiSummary | null> {
  const searchUrl = `https://${lang}.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(
    `${artist} ${title}`,
  )}&format=json&origin=*&srlimit=5`
  const searchResult = await fetchJson<{ query?: { search?: { title?: string }[] } }>(searchUrl).catch(() => null)
  const titles = (searchResult?.query?.search || []).map((r) => r.title).filter((t): t is string => Boolean(t))
  if (!titles.length) return null

  const candidates = (
    await Promise.all(
      titles.map((pageTitle) => fetchAlbumCandidateSummary(title, artist, lang, pageTitle).catch(() => null)),
    )
  ).filter(Boolean)

  let best = null
  let bestScore = -1
  for (const candidate of candidates) {
    // Preferir el candidato que menciona explícitamente al artista.
    const text = `${candidate?.description || ''} ${candidate?.extract || ''}`
    const score = normalize(artist || '') && containsAny(text, [normalize(artist)]) ? 2 : 1
    if (score > bestScore) {
      best = candidate
      bestScore = score
    }
  }
  return best
}

export async function lookupAlbumBio(title: string | null | undefined, artist: string | null | undefined): Promise<WikipediaBio | null> {
  if (!title?.trim()) return null

  const key = cacheKeyFor(`album:${artist || ''}:${title}`)
  const cache = readCache()
  const cached = cache[key]
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached.value

  try {
    const esResult = await lookupAlbumInLang(title, artist ?? '', 'es').catch(() => null)
    let value: WikipediaBio | null = esResult
      ? {
          summary: esResult.extract ?? null,
          thumb: upscaleWikiThumb(esResult.thumbnail?.source) || null,
          wikipediaUrl: esResult.content_urls?.desktop?.page || null,
        }
      : null
    if (!value) {
      const enResult = await lookupAlbumInLang(title, artist ?? '', 'en').catch(() => null)
      if (enResult) {
        value = {
          summary: await translateToSpanish(enResult.extract ?? null),
          thumb: upscaleWikiThumb(enResult.thumbnail?.source) || null,
          wikipediaUrl: enResult.content_urls?.desktop?.page || null,
          translated: true,
        }
      }
    }
    cache[key] = { value, fetchedAt: Date.now() }
    writeCache(cache)
    return value
  } catch (e) {
    console.warn('[XFY] Wikipedia lookup de álbum falló')
    return null
  }
}
