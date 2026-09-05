// Extrae un color "vibrante" dominante de una imagen o de un frame de
// video, para theming adaptativo (igual concepto que el "Canvas color"
// de Spotify o el acento dinámico de Apple Music: la UI toma el color
// del arte en vez de un acento fijo).
//
// No depende de ninguna librería — es un cuantizador simple: reduce cada
// canal a baldes de 24 niveles, cuenta frecuencias, y entre los baldes
// más frecuentes elige el más "vivo" (ni casi negro, ni casi blanco, ni
// gris muerto) en vez de simplemente el más frecuente a secas — si no,
// en portadas oscuras siempre ganaría un negro/gris sin gracia.

const BUCKET = 24

/** Color RGB con canales en 0-255. */
export type RGB = [number, number, number]

function quantize(value: number): number {
  return Math.round(value / BUCKET) * BUCKET
}

function toHsl(r: number, g: number, b: number): { s: number; l: number } {
  const rn = r / 255
  const gn = g / 255
  const bn = b / 255
  const max = Math.max(rn, gn, bn)
  const min = Math.min(rn, gn, bn)
  const l = (max + min) / 2
  let s = 0
  if (max !== min) {
    s = l > 0.5 ? (max - min) / (2 - max - min) : (max - min) / (max + min)
  }
  return { s, l }
}

/**
 * @param source imagen o video ya cargado
 * @returns el color dominante "vivo", o null si la fuente no sirvió
 */
export function extractDominantColor(source: CanvasImageSource): { rgb: RGB } | null {
  const canvas = document.createElement('canvas')
  const size = 48
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) return null

  try {
    ctx.drawImage(source, 0, 0, size, size)
  } catch {
    // Fuente todavía no lista / CORS: no hay palette esta vez, no pasa nada
    return null
  }

  let data: Uint8ClampedArray
  try {
    data = ctx.getImageData(0, 0, size, size).data
  } catch {
    // Canvas "tainted" (imagen cross-origin sin CORS habilitado)
    return null
  }

  interface Bucket {
    count: number
    r: number
    g: number
    b: number
  }
  const buckets = new Map<string, Bucket>()

  for (let i = 0; i < data.length; i += 4) {
    const r = data[i]!
    const g = data[i + 1]!
    const b = data[i + 2]!
    const alpha = data[i + 3]!
    if (alpha < 200) continue

    const { s, l } = toHsl(r, g, b)
    // Descarta casi-negro, casi-blanco y grises sin saturación: no sirven
    // como acento, aunque sean el color más común de la imagen.
    if (l < 0.08 || l > 0.92 || s < 0.12) continue

    const key = `${quantize(r)}-${quantize(g)}-${quantize(b)}`
    const bucket = buckets.get(key)
    // Puntaje: frecuencia, pero pesando saturación para preferir colores
    // vivos sobre colores apagados igual de frecuentes.
    const weight = 1 + s
    if (bucket) {
      bucket.count += weight
    } else {
      buckets.set(key, { count: weight, r, g, b })
    }
  }

  if (buckets.size === 0) return null

  let best: Bucket | null = null
  for (const bucket of buckets.values()) {
    if (!best || bucket.count > best.count) best = bucket
  }
  if (!best) return null

  return { rgb: [best.r, best.g, best.b] }
}

function clamp255(n: number): number {
  return Math.max(0, Math.min(255, Math.round(n)))
}

function toHex([r, g, b]: RGB): string {
  return `#${[r, g, b].map((n) => clamp255(n).toString(16).padStart(2, '0')).join('')}`
}

function lighten([r, g, b]: RGB, amount: number): RGB {
  return [
    clamp255(r + (255 - r) * amount),
    clamp255(g + (255 - g) * amount),
    clamp255(b + (255 - b) * amount),
  ]
}

// Luminancia relativa (WCAG 2.x) — mismo criterio que un checker de
// contraste real, no solo "lightness" de HSL (que subestima cuánto pesa el
// verde vs el azul en cómo se percibe el brillo).
function relativeLuminance([r, g, b]: RGB): number {
  const chan = (c: number): number => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * chan(r) + 0.7152 * chan(g) + 0.0722 * chan(b)
}

// Piso mínimo de luminancia para un color que se va a usar como TEXTO
// (accentStrong: links, botón "Leer más" en hover, etc.) sobre el fondo
// oscuro de la app (--bg: #06060a). Sin este piso, una portada dominada por
// un azul o violeta muy oscuro pasaba el filtro de "no gris muerto" de
// extractDominantColor y aun así rendía casi ilegible como color de texto.
const MIN_TEXT_LUMINANCE = 0.32

/** Aclara progresivamente hasta alcanzar MIN_TEXT_LUMINANCE, o hasta un tope
 * de aclarado (0.85) para no terminar en blanco puro y perder el matiz. */
function ensureReadable(rgb: RGB): RGB {
  let amount = 0
  let candidate = rgb
  while (relativeLuminance(candidate) < MIN_TEXT_LUMINANCE && amount < 0.85) {
    amount += 0.08
    candidate = lighten(rgb, amount)
  }
  return candidate
}

/** Variables --accent-* derivadas de un color dominante (mismo shape que tokens.css). */
export interface AdaptiveTheme {
  accent: string
  accentStrong: string
  accentDim: string
  accentGlow: string
  /** Canales en 0-1, para tinting de shaders (Kawarp). */
  rgbFloat: [number, number, number]
}

/**
 * Deriva el set completo de variables --accent-* (mismo shape que ya usa
 * tokens.css) a partir de un color RGB dominante.
 */
export function buildAdaptiveTheme(rgb: RGB): AdaptiveTheme {
  const [r, g, b] = rgb
  // accentStrong se usa como color de TEXTO (links, hover) — necesita el
  // piso de contraste. accent se usa sobre todo como fondo de superficies
  // (botón "Reproducir", etc.), donde el propio color extraído ya funciona
  // sin aclarar de más.
  const strong = ensureReadable(lighten(rgb, 0.18))
  return {
    accent: toHex(rgb),
    accentStrong: toHex(strong),
    accentDim: `rgba(${r}, ${g}, ${b}, 0.16)`,
    accentGlow: `rgba(${r}, ${g}, ${b}, 0.55)`,
    rgbFloat: [r / 255, g / 255, b / 255],
  }
}
