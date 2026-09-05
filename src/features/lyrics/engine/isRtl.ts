// Detección de texto RTL (árabe, hebreo, persa, etc), portada de
// Spikerko/spicy-lyrics (src/utils/Lyrics/isRtl.ts). El proyecto real la
// usa para: (a) poner dir="rtl" en la línea completa, (b) invertir el
// sentido en que se "llena" el karaoke-word-fill (de derecha a izquierda
// en vez de izquierda a derecha), y (c) elegir la fuente Vazirmatn para
// texto árabe/persa (ver letterEmphasis.js).
//
// Salta dígitos, espacios y puntuación al buscar el primer carácter con
// direccionalidad fuerte, así "123 שלום" se detecta como RTL en vez de
// quedar indeciso por el número inicial.

const RTL_RANGES =
  /[\u0590-\u05FF\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB1D-\uFB4F\uFB50-\uFDFF\uFE70-\uFEFF]/

const NEUTRAL_CHARS = /[\d\s,.;:?!()[\]{}"'\\/<>@#$%^&*_=+-]/

/** Regex específico para árabe/persa (usado para elegir tipografía). */
export const ArabicPersianRegex = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/

export function isRtl(text: string | null | undefined): boolean {
  if (!text || text.length === 0) return false

  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (char === undefined) break
    if (NEUTRAL_CHARS.test(char)) continue
    return RTL_RANGES.test(char)
  }

  return false
}

// MEJORA de performance: antes index.html cargaba la fuente Vazirmatn (Google
// Fonts) de forma incondicional en el <head> para TODA sesión — un request
// externo (+ 2 preconnects) en la carga inicial que casi ningún usuario llega
// a necesitar, porque solo aplica a letras en árabe/persa (ver LyricLine.tsx).
// Ahora se inyecta bajo demanda, una sola vez, la primera vez que una letra
// realmente contiene texto árabe/persa — así la carga inicial de la app no
// paga el costo de red de una tipografía que la gran mayoría de sesiones
// nunca renderiza.
let rtlFontRequested = false

export function ensureRtlFontLoaded(): void {
  if (rtlFontRequested || typeof document === 'undefined') return
  rtlFontRequested = true

  const preconnect1 = document.createElement('link')
  preconnect1.rel = 'preconnect'
  preconnect1.href = 'https://fonts.googleapis.com'
  const preconnect2 = document.createElement('link')
  preconnect2.rel = 'preconnect'
  preconnect2.href = 'https://fonts.gstatic.com'
  preconnect2.crossOrigin = 'anonymous'
  const stylesheet = document.createElement('link')
  stylesheet.rel = 'stylesheet'
  stylesheet.href = 'https://fonts.googleapis.com/css2?family=Vazirmatn:wght@400;600;700&display=swap'

  document.head.append(preconnect1, preconnect2, stylesheet)
}

export default isRtl
