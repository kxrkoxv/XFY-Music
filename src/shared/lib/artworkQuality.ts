// ============================================================
// Portada en máxima calidad real — para Media Session (notificación /
// pantalla de bloqueo) y cualquier consumidor que quiera nitidez.
//
// Por qué existía el blur: MediaSessionSync declaraba sizes 96/256/512
// sin importar la resolución REAL del archivo. iOS/Android escalan al
// `sizes` declarado: si la imagen real es 1200x1200 (Apple) o 544x544
// (thumb de YT Music), declararla "512x512" la degrada. La regla de
// Spotify/Apple es servir el archivo más grande disponible y declarar
// sus dimensiones VERDADERAS — eso es exactamente lo que hace este
// módulo:
//
//   1. upgradeArtworkUrl(): sube la URL al tamaño máximo conocido por
//      patrón (mzstatic → 1200x1200bb; googleusercontent → w1200-h1200).
//   2. probeArtworkSize(): mide las dimensiones reales decodificando la
//      imagen una sola vez (cacheado por URL en un Map de módulo).
//   3. buildArtworkLadder(): arma el array de artwork con sizes
//      verdaderos — un solo entry basta cuando el src ya es max-res.
// ============================================================

const dimensionCache = new Map<string, Promise<{ w: number; h: number } | null>>() // url -> Promise<{w, h} | null>

/**
 * Reescribe la URL a su variante de máxima resolución conocida.
 * Devuelve la URL original si no matchea ningún patrón conocido.
 */
export function upgradeArtworkUrl(url: string | null | undefined): string {
  if (!url || typeof url !== 'string') return url ?? ''

  // Apple (mzstatic): NNNxNNNbb.jpg|png|webp → 1200x1200. Es el tope que
  // Apple sirve sin caer a un tamaño menor (ver appleClient.js).
  const mz = url.match(/\/(\d+)x(\d+)bb\.(jpg|png|webp)(\?|$)/)
  if (mz) {
    const size = parseInt(mz[1] ?? '0', 10)
    if (size < 1200) return url.replace(/\/\d+x\d+bb\.(jpg|png|webp)/, '/1200x1200bb.$1')
    return url
  }

  // Google (googleusercontent / youtubeusercontent): los thumbs de YT Music
  // vienen con sufijo =wN-hN... (=sN también existe). El mismo asset sirve
  // hasta ~1200px reescribiendo el tamaño pedido.
  if (/https?:\/\/(lh\d|play\.googleusercontent|i\.youtube)\.com\//.test(url) || /((lh3|yt3|lh5|lh6)\.googleusercontent\.com|(i9?|i)\.ytimg\.com)/.test(url)) {
    if (/=w\d+-h\d+/.test(url)) return url.replace(/=w\d+-h\d+/, '=w1200-h1200')
    if (/=s\d+/.test(url)) return url.replace(/=s\d+/, '=s1200')
  }

  // ytimg clásico (video frames): hqdefault/sddefault tienen variantes
  // maxresdefault — si no existe, el probe falla y devolvemos la original.
  const ytimg = url.match(/^(https:\/\/i\.ytimg\.com\/vi(?:_webp)?\/[^/]+\/)(hqdefault|mqdefault|default)(\.jpg)$/)
  if (ytimg) {
    return `${ytimg[1]}maxresdefault${ytimg[3]}`
  }

  return url
}

/**
 * Mide las dimensiones reales de una imagen (una vez por URL).
 * Devuelve null si no se puede decodificar (404, CORS de decode, etc.).
 */
export function probeArtworkSize(url: string): Promise<{ w: number; h: number } | null> {
  const cached = dimensionCache.get(url)
  if (cached) return cached

  const promise = new Promise<{ w: number; h: number } | null>((resolve) => {
    if (typeof window === 'undefined' || typeof Image === 'undefined') return resolve(null)
    const img = new Image()
    const done = (result: { w: number; h: number } | null) => {
      dimensionCache.set(url, Promise.resolve(result))
      resolve(result)
    }
    img.onload = () => {
      const w = img.naturalWidth
      const h = img.naturalHeight
      if (!w || !h) return done(null)
      done({ w, h })
    }
    img.onerror = () => {
      // Si falló una variante "mejorada" (ej. maxresdefault inexistente),
      // reintentamos una única vez contra la URL original sin upgrade.
      resolve(null)
    }
    img.src = url
    // Red de seguridad: no colgar el metadata de Media Session por una imagen lenta.
    setTimeout(() => resolve(null), 8000)
  })

  dimensionCache.set(url, promise)
  return promise
}

function guessType(url = ''): string {
  if (/\.png($|\?)/i.test(url)) return 'image/png'
  if (/\.webp($|\?)/i.test(url)) return 'image/webp'
  return 'image/jpeg'
}

/** Entrada de artwork para MediaSession.metadata con sizes verdaderos. */
export interface MediaSessionArtwork {
  src: string
  sizes: string
  type: string
}

/**
 * Ladder de artwork para MediaSession.metadata con sizes VERDADEROS.
 *
 * Estrategia: probar primero la URL upgraded; si el probe la resuelve,
 * esa es la entrada (los sistemas toman siempre el entry más grande y
 * escalan hacia abajo con calidad). Si el upgrade no existe (404),
 * probamos la URL original; si nada se puede medir, entregamos la
 * original declarando 640x640 como mejor estimación conservadora.
 */
export async function buildArtworkLadder(originalUrl: string | null | undefined): Promise<MediaSessionArtwork[]> {
  if (!originalUrl) return []

  const upgraded = upgradeArtworkUrl(originalUrl)
  const candidates = upgraded !== originalUrl ? [upgraded, originalUrl] : [originalUrl]

  for (const candidate of candidates) {
    const size = await probeArtworkSize(candidate)
    if (size && size.w >= 96) {
      return [{ src: candidate, sizes: `${size.w}x${size.h}`, type: guessType(candidate) }]
    }
  }

  return originalUrl ? [{ src: originalUrl, sizes: '640x640', type: guessType(originalUrl) }] : []
}
