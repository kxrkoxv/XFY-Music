// ============================================================
// Claridad del vidrio — control de "Claro ↔ Tintado" para las
// superficies de Liquid Glass de la app (tab bar, mini-player, chips),
// inspirado en el slider que Apple sumó a iOS 27 (WWDC 2026) después de
// que la transparencia por defecto de Liquid Glass en iOS 26 recibiera
// quejas de legibilidad. Ver el comentario grande sobre --glass-clarity
// en tokens.css para cómo cada superficie lo consume.
//
// Vive separado de themes.ts a propósito: el tema define COLOR (paleta),
// esto define DENSIDAD del vidrio — son ejes independientes, cualquier
// combinación de tema + claridad tiene que quedar bien.
// ============================================================

export type GlassClarityId = 'clear' | 'balanced' | 'tinted'

export const GLASS_CLARITY_OPTIONS: { id: GlassClarityId; label: string; desc: string }[] = [
  { id: 'clear', label: 'Claro', desc: 'Más transparente — se ve más lo de atrás' },
  { id: 'balanced', label: 'Equilibrado', desc: 'El vidrio de referencia de XFY' },
  { id: 'tinted', label: 'Tintado', desc: 'Más opaco — mejor legibilidad' },
]

const VALID_IDS = new Set<string>(GLASS_CLARITY_OPTIONS.map((o) => o.id))

export function isValidGlassClarity(id: string | null | undefined): id is GlassClarityId {
  return !!id && VALID_IDS.has(id)
}

/** 'balanced' no escribe atributo: usa los valores base de tokens.css
 *  directo (clarity: 1), igual que 'default-dark' no escribe overrides
 *  de color en themes.js. */
export function applyGlassClarity(id: GlassClarityId | null | undefined): void {
  const root = document.documentElement
  if (!id || id === 'balanced') {
    root.removeAttribute('data-glass')
    return
  }
  root.setAttribute('data-glass', id)
}
