// ============================================================
// Sistema de temas — porteado del XFY viejo (glassmorphism, 16 temas
// + creador de temas personalizados) y adaptado al set de tokens
// actual (src/styles/tokens.css). A diferencia del sistema anterior
// (que solo tocaba --accent-*), cada tema de acá recolorea la app
// entera: fondo, superficies, texto y el "vidrio" de las barras
// flotantes.
//
// Cada tema se arma con `createTheme(...)` a partir de un puñado de
// colores base (no hace falta escribir los ~14 tokens a mano por
// tema): el resto se deriva con las mismas fórmulas que ya usan los
// tokens por defecto en tokens.css (--text-secondary/--text-tertiary
// son --text-primary con menos opacidad, --glass-* son variantes con
// alfa del color elevado, etc.), así que un tema nuevo siempre queda
// visualmente coherente con el resto del diseño.
//
// applyTheme() escribe los tokens como inline styles en <html> (en
// vez de depender de bloques CSS estáticos por [data-theme]), porque
// los temas personalizados del usuario tienen colores arbitrarios que
// no existen en ningún CSS precompilado.
// ============================================================

const TOKEN_KEYS = [
  '--bg',
  '--bg-elevated',
  '--surface',
  '--surface-hover',
  '--surface-active',
  '--border',
  '--accent',
  '--accent-strong',
  '--accent-dim',
  '--accent-glow',
  '--text-primary',
  '--text-secondary',
  '--text-tertiary',
  '--glass-bg',
  '--glass-border',
  '--glass-highlight',
  '--chip-bg',
] as const

/** Token CSS → valor. Exactamente las claves que applyTheme escribe en <html>. */
export type ThemeColors = Record<(typeof TOKEN_KEYS)[number], string>

/**
 * Shape mínimo que applyTheme sabe aplicar: los temas personalizados del
 * usuario viven en IndexedDB como Record<string,string> genérico y pueden
 * venir con claves parciales — solo se escriben las que traigan valor.
 */
export interface ApplicableTheme {
  id: string
  name: string
  colors: Partial<ThemeColors> | null
}

/** Un tema completo: los predefinidos traen swatches; los custom pueden no. */
export interface Theme extends ApplicableTheme {
  swatchBg?: string
  swatchAccent?: string
  swatchCheck?: string
  /** null = tema base de tokens.css (default-dark): no overridea nada. */
  colors: ThemeColors | null
}

// --- Utilidades de color (porteadas del creador de temas viejo) ---
export function isValidHexColor(hex: string): boolean {
  return typeof hex === 'string' && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(hex.trim())
}

function normalizeHex(hex: string): string {
  const h = hex.trim().replace('#', '')
  if (h.length === 3) {
    return h
      .split('')
      .map((c) => c + c)
      .join('')
  }
  return h
}

export function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const h = normalizeHex(hex)
  const num = Number.parseInt(h, 16)
  return { r: (num >> 16) & 255, g: (num >> 8) & 255, b: num & 255 }
}

export function hexToRgbString(hex: string): string {
  const { r, g, b } = hexToRgb(hex)
  return `${r},${g},${b}`
}

function withOpacity(rgbString: string, opacity: number | string): string {
  return `rgba(${rgbString},${opacity})`
}

function clamp255(n: number): number {
  return Math.max(0, Math.min(255, Math.round(n)))
}

// Aclara (percent > 0) u oscurece (percent < 0) un color hex.
function lightenDarken(hex: string, percent: number): string {
  const { r, g, b } = hexToRgb(hex)
  const amt = Math.round((percent / 100) * 255)
  const toHex = (v: number): string => clamp255(v + amt).toString(16).padStart(2, '0')
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`
}

// Interpola linealmente entre dos colores hex (weight: 0 = a, 1 = b).
function mixHex(hexA: string, hexB: string, weight: number): string {
  const a = hexToRgb(hexA)
  const b = hexToRgb(hexB)
  const mix = (x: number, y: number): number => clamp255(x + (y - x) * weight)
  const toHex = (v: number): string => v.toString(16).padStart(2, '0')
  return `#${toHex(mix(a.r, b.r))}${toHex(mix(a.g, b.g))}${toHex(mix(a.b, b.b))}`
}

// Luminancia relativa aproximada — solo para decidir si un fondo es
// "claro" u "oscuro" y así elegir overlays blancos o negros.
function relativeLuminance(hex: string): number {
  const { r, g, b } = hexToRgb(hex)
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255
}

interface BuildColorsCfg {
  bg: string
  bgElevated: string
  accent: string
  accentStrong: string
  ink: string
  border: string
  overlayRGB: string
  glassRGB: string
}

/**
 * Arma el objeto `colors` completo (los TOKEN_KEYS) a partir de un
 * puñado de colores base. Usado tanto por los temas predefinidos
 * como por el creador de temas personalizados.
 */
function buildColors({ bg, bgElevated, accent, accentStrong, ink, border, overlayRGB, glassRGB }: BuildColorsCfg): ThemeColors {
  const accentRgb = hexToRgbString(accent)
  // Los chips de vidrio flotantes (botón atrás/favorito del player) van en
  // el tono INVERSO al overlay: en temas oscuros son vidrio oscuro sobre
  // oscuro, en claros vidrio blanco sobre claro — con el overlay directo
  // quedaban como manchas oscuras en los temas claros.
  const chipRGB = relativeLuminance(bg) > 0.5 ? '255,255,255' : '30,30,34'
  return {
    '--bg': bg,
    '--bg-elevated': bgElevated,
    '--surface': withOpacity(overlayRGB, 0.05),
    '--surface-hover': withOpacity(overlayRGB, 0.09),
    '--surface-active': withOpacity(overlayRGB, 0.13),
    '--border': border,
    '--accent': accent,
    '--accent-strong': accentStrong,
    '--accent-dim': withOpacity(accentRgb, 0.16),
    '--accent-glow': withOpacity(accentRgb, 0.55),
    '--text-primary': ink,
    '--text-secondary': withOpacity(hexToRgbString(ink), 0.68),
    '--text-tertiary': withOpacity(hexToRgbString(ink), 0.42),
    '--glass-bg': withOpacity(glassRGB, 'min(1, calc(0.66 * var(--glass-clarity)))'),
    '--glass-border': withOpacity(overlayRGB, 'min(1, calc(0.14 * var(--glass-clarity)))'),
    '--glass-highlight': withOpacity(overlayRGB, 'min(1, calc(0.22 * var(--glass-clarity)))'),
    '--chip-bg': withOpacity(chipRGB, 'min(1, calc(0.45 * var(--glass-clarity)))'),
  }
}

function createTheme(id: string, name: string, cfg: BuildColorsCfg): Theme {
  return {
    id,
    name,
    swatchBg: cfg.bg,
    swatchAccent: cfg.accent,
    // El ✓ del swatch seleccionado necesita contraste contra el fondo del
    // propio tema (blanco sobre temas oscuros, casi negro sobre claros).
    swatchCheck: relativeLuminance(cfg.bg) > 0.5 ? '#18181c' : '#ffffff',
    colors: buildColors(cfg),
  }
}

// --- Catálogo de temas ---
// Recalibrado con paletas de referencia del ecosistema (Nord, Tokyo Night,
// Everforest, Dracula, Solarized, Catppuccin) y los principios de dark UI
// bien hecho: superficies en grises oscuros (nunca negro puro — no se
// puede elevar), UN acento principal coherente con su variante strong
// (misma familia de hue, ajustando luminancia), texto con contraste real
// contra su fondo y elevación aclarando, nunca oscureciendo.
// IDs y nombres intactos a propósito: viven en las preferencias guardadas
// de cada usuario — cambiarlos "pierde" el tema de toda la base.
export const THEMES: Theme[] = [
  // El tema por defecto no lleva `colors`: es la base ya definida en
  // tokens.css, así que aplicarlo es simplemente no overridear nada.
  {
    id: 'default-dark',
    name: 'Violeta',
    swatchBg: '#06060a',
    swatchAccent: '#8b5cf6',
    swatchCheck: '#ffffff',
    colors: null,
  },

  // Blanco puro para pantallas OLED (píxeles apagados = negro real de
  // contraste; el blanco acá es intencional, no un descuido).
  createTheme('oled-claro', 'OLED Claro', {
    bg: '#ffffff',
    bgElevated: '#f8f9fa',
    accent: '#7e57c2',
    accentStrong: '#5e35b1',
    ink: '#212529',
    border: '#dee2e6',
    overlayRGB: '0,0,0',
    glassRGB: '248,249,250',
  }),
  // Nord Snow Storm — la variante clara del ártico.
  createTheme('arctic-light', 'Ártico Claro', {
    bg: '#eceff4',
    bgElevated: '#e5e9f0',
    accent: '#5e81ac',
    accentStrong: '#3b577a',
    ink: '#2e3440',
    border: '#d8dee9',
    overlayRGB: '46,52,64',
    glassRGB: '229,233,240',
  }),
  // Everforest (dark medium) — verde bosque asentado, no el verde
  // saturado de Material 2014.
  createTheme('forest-deep', 'Bosque Profundo', {
    bg: '#2d353b',
    bgElevated: '#343f44',
    accent: '#a7c080',
    accentStrong: '#c0cc8e',
    ink: '#d3c6aa',
    border: '#414b50',
    overlayRGB: '211,198,170',
    glassRGB: '52,63,68',
  }),
  // Tokyo Night — el azul-violeta de la skyline nocturna.
  createTheme('ocean-night', 'Océano Nocturno', {
    bg: '#1a1b26',
    bgElevated: '#24283b',
    accent: '#7aa2f7',
    accentStrong: '#9dc0ff',
    ink: '#c0caf5',
    border: '#292e42',
    overlayRGB: '192,202,245',
    glassRGB: '36,40,59',
  }),
  createTheme('sunset-glow', 'Atardecer Cálido', {
    bg: '#251a33',
    bgElevated: '#3a2b4d',
    accent: '#ff9e64',
    accentStrong: '#ffb380',
    ink: '#ede7fb',
    border: '#4a3a63',
    overlayRGB: '237,231,251',
    glassRGB: '58,43,77',
  }),
  createTheme('rose-quartz', 'Cuarzo Rosa', {
    bg: '#fdf2f4',
    bgElevated: '#f9e0e6',
    accent: '#d64570',
    accentStrong: '#b23a5e',
    ink: '#4a2b35',
    border: '#f0ccd6',
    overlayRGB: '74,43,53',
    glassRGB: '249,224,230',
  }),
  // Dracula — neón sobre berenjena, la referencia del género.
  createTheme('cyber-neon', 'Cyber Neon', {
    bg: '#16121f',
    bgElevated: '#221a33',
    accent: '#bd93f9',
    accentStrong: '#d5b3ff',
    ink: '#e6e6f0',
    border: '#37294f',
    overlayRGB: '189,147,249',
    glassRGB: '34,26,51',
  }),
  // Solarized Light — la paleta clara científicamente calibrada.
  createTheme('vintage-sepia', 'Vintage Sepia', {
    bg: '#fdf6e3',
    bgElevated: '#eee8d5',
    accent: '#b58900',
    accentStrong: '#8f6900',
    ink: '#586e75',
    border: '#ddd6c1',
    overlayRGB: '88,110,117',
    glassRGB: '238,232,213',
  }),
  createTheme('crimson-night', 'Noche Carmesí', {
    bg: '#170d10',
    bgElevated: '#241318',
    accent: '#e5484d',
    accentStrong: '#ff6b70',
    ink: '#f2e8ea',
    border: '#3d1f26',
    overlayRGB: '242,232,234',
    glassRGB: '36,19,24',
  }),
  createTheme('lavender-dream', 'Sueño Lavanda', {
    bg: '#f3f0fa',
    bgElevated: '#e9e4f6',
    accent: '#7a5fd0',
    accentStrong: '#5f48b8',
    ink: '#3a3552',
    border: '#d5cef0',
    overlayRGB: '58,53,82',
    glassRGB: '233,228,246',
  }),
  createTheme('minty-cool', 'Menta Fresca', {
    bg: '#f2fbf5',
    bgElevated: '#e0f5e9',
    accent: '#2ea882',
    accentStrong: '#1f8a63',
    ink: '#274740',
    border: '#c4e8d4',
    overlayRGB: '39,71,64',
    glassRGB: '224,245,233',
  }),
  // Grafito: el acento gris necesita luminancia alta para no morir sobre
  // el fondo — gris claro, no gris medio.
  createTheme('grayscale-modern', 'Escala de Grises', {
    bg: '#17181a',
    bgElevated: '#242527',
    accent: '#9d9da8',
    accentStrong: '#c2c2cc',
    ink: '#e8e8ec',
    border: '#33343a',
    overlayRGB: '232,232,236',
    glassRGB: '36,37,39',
  }),
  // Ámbar Tailwind (600/700): el #ffab00 original no tenía contraste
  // suficiente contra fondo claro para texto e íconos.
  createTheme('golden-hour', 'Hora Dorada', {
    bg: '#fff9ef',
    bgElevated: '#ffefdb',
    accent: '#d97706',
    accentStrong: '#b45309',
    ink: '#57431f',
    border: '#f5dfb8',
    overlayRGB: '87,67,31',
    glassRGB: '255,239,219',
  }),
  createTheme('deep-space', 'Espacio Profundo', {
    bg: '#0f0d20',
    bgElevated: '#1d1936',
    accent: '#9077e0',
    accentStrong: '#b8a6ff',
    ink: '#e6e4f5',
    border: '#37305e',
    overlayRGB: '230,228,245',
    glassRGB: '29,25,54',
  }),
  createTheme('pride-spectrum', 'Pride Spectrum', {
    bg: '#ffffff',
    bgElevated: '#fdf3f8',
    accent: '#e13c74',
    accentStrong: '#c22a5e',
    ink: '#32204d',
    border: '#f6d5e5',
    overlayRGB: '50,32,77',
    glassRGB: '253,243,248',
  }),
  // Onyx — negro absoluto (0,0,0), no un gris muy oscuro. Mismo espíritu
  // que el tema "Onyx" que Discord sumó en su rediseño 2026 para pantallas
  // OLED: cada píxel negro se apaga del todo en vez de emitir un gris
  // oscuro, así que ahorra batería y da más contraste que 'default-dark'
  // (que ya es casi negro, pero no del todo — #06060a sigue emitiendo
  // algo). El acento queda gris-azulado neutro, a propósito: un tema
  // "Onyx" pide minimalismo, no otro acento de color saturado.
  createTheme('onyx', 'Onyx', {
    bg: '#000000',
    bgElevated: '#0a0a0c',
    accent: '#8e9aab',
    accentStrong: '#c3ccd9',
    ink: '#f2f3f5',
    border: '#1c1d21',
    overlayRGB: '242,243,245',
    glassRGB: '10,10,12',
  }),
]

/**
 * Aplica un tema (por id, entre los predefinidos o los personalizados
 * del usuario, o pasando directamente el objeto {id, name, colors}).
 * Si no se encuentra nada usable, cae en 'default-dark'.
 *
 * Con `animate: true` el swap va dentro de document.startViewTransition:
 * el navegador captura un snapshot del estado viejo, aplica el tema y
 * crossfadea — el cambio de tema se ve como un fundido suave de toda la
 * app en vez de un corte seco. Fallback: browsers sin la API (y usuarios
 * con reduced-motion) aplican el cambio instantáneo, como siempre.
 * También expone el modo claro/oscuro en data-theme-mode + evento
 * 'xfy:themechange', para que piezas fuera de los tokens (los toasts de
 * Sonner, por ejemplo) puedan seguir el tema.
 */
export function applyTheme(
  themeIdOrObject: string | ApplicableTheme | null | undefined,
  customThemesCache: ApplicableTheme[] = [],
  { animate: withAnimation = false }: { animate?: boolean } = {},
): void {
  let theme: ApplicableTheme | undefined
  if (typeof themeIdOrObject === 'string') {
    theme =
      THEMES.find((t) => t.id === themeIdOrObject) ||
      customThemesCache.find((t) => t.id === themeIdOrObject)
  } else if (themeIdOrObject && typeof themeIdOrObject === 'object') {
    theme = themeIdOrObject
  }
  if (!theme) {
    const fallback = THEMES[0]
    if (!fallback) return
    theme = fallback
  }

  const apply = (): void => {
    const root = document.documentElement
    if (theme.colors) {
      for (const key of TOKEN_KEYS) {
        const value = theme.colors[key]
        if (value !== undefined) root.style.setProperty(key, value)
      }
    } else {
      // 'default-dark' u otro tema sin overrides: limpia cualquier
      // inline style que haya quedado de un tema anterior para que
      // vuelvan a mandar los valores base de tokens.css.
      for (const key of TOKEN_KEYS) {
        root.style.removeProperty(key)
      }
    }
    root.setAttribute('data-theme', theme.id)
    const bgHex = theme.colors?.['--bg']
    const mode = bgHex && relativeLuminance(bgHex) > 0.5 ? 'light' : 'dark'
    root.dataset.themeMode = mode
    window.dispatchEvent(new CustomEvent('xfy:themechange', { detail: { id: theme.id, mode } }))
  }

  const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  if (withAnimation && !prefersReducedMotion && typeof document.startViewTransition === 'function') {
    document.startViewTransition(apply)
    return
  }
  apply()
}

/**
 * Arma un tema personalizado completo a partir de los 4 colores que
 * elige el usuario en el creador (fondo, fondo secundario, acento,
 * texto) — el resto (hover del acento, bordes, overlays de vidrio) se
 * deriva automáticamente, igual que hacía el XFY viejo.
 */
export function buildCustomTheme({ name, bg, bgElevated, accent, ink }: {
  name: string
  bg: string
  bgElevated: string
  accent: string
  ink: string
}): { id: string; name: string; colors: ThemeColors } {
  const isLight = relativeLuminance(bg) > 0.5
  const accentStrong = lightenDarken(accent, isLight ? -18 : 16)
  const border = mixHex(bg, ink, 0.22)
  const overlayRGB = isLight ? '0,0,0' : '255,255,255'
  const glassRGB = hexToRgbString(bgElevated)

  return {
    id: `custom_${crypto.randomUUID().slice(0, 8)}`,
    name: name.trim(),
    colors: buildColors({ bg, bgElevated, accent, accentStrong, ink, border, overlayRGB, glassRGB }),
  }
}
