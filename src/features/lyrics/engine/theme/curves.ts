// Curvas de animación por palabra, portadas de Spicy Lyrics
// (src/utils/Lyrics/Animator/Lyrics/LyricsAnimator.ts). Los valores de
// las curvas (los "Range") son los mismos que usa la extensión real —
// son los que le dan esa sensación característica de "pop" al cantar
// cada palabra. Lo que cambia es cómo se disparan: la extensión original
// las conecta al reloj de reproducción de Spotify; acá las conectamos al
// currentTime del store del reproductor.

import Spline from 'cubic-spline'

/** Punto de una curva de animación (mismo vocabulario que la extensión original). */
interface CurvePoint {
  Time: number
  Value: number
}

/** Parámetros de resorte físico: frecuencia en Hz y damping ratio 0-1. */
export interface SpringConfig {
  frequency: number
  damping: number
}

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max))
}

function getSpline(range: CurvePoint[]): Spline {
  const times = range.map((p) => p.Time)
  const values = range.map((p) => p.Value)
  return new Spline(times, values)
}

// Escala de la palabra completa mientras se canta: arranca un poco chica,
// hace un pico por encima de 1 a los 2/3 del progreso, y se asienta en 1.
const WordScaleRange: CurvePoint[] = [
  { Time: 0, Value: 0.95 },
  { Time: 0.7, Value: 1.05 },
  { Time: 1, Value: 1 },
]

// Desplazamiento vertical sutil (efecto "salto" al cantar)
const WordYOffsetRange: CurvePoint[] = [
  { Time: 0, Value: 1 / 100 },
  { Time: 0.9, Value: -(1 / 60) },
  { Time: 1, Value: 0 },
]

// Glow/resplandor: aparece rápido, se sostiene, y se apaga al terminar
const WordGlowRange: CurvePoint[] = [
  { Time: 0, Value: 0 },
  { Time: 0.15, Value: 1 },
  { Time: 0.6, Value: 1 },
  { Time: 1, Value: 0 },
]

export const WordScaleSpline = getSpline(WordScaleRange)
export const WordYOffsetSpline = getSpline(WordYOffsetRange)
export const WordGlowSpline = getSpline(WordGlowRange)

// Constantes de resorte físico (frecuencia en Hz, damping ratio 0-1)
// tomadas de la extensión original — así el movimiento de cada palabra
// no salta directo al valor de la curva sino que "persigue" ese valor
// con inercia real (usando modules/Spring.js, port 1:1 de Fraktality/spr).
export const SPRING: Record<'scale' | 'yOffset' | 'glow', SpringConfig> = {
  scale: { frequency: 0.88, damping: 0.64 },
  yOffset: { frequency: 1.45, damping: 0.4 },
  glow: { frequency: 1.18, damping: 0.56 },
}

// --- GlassyFlow (better-lyrics-glassy) ---
// El original resuelve el resorte con stiffness/damping/mass (k/c/m,
// oscilador armónico amortiguado clásico) en vez de frequency/dampingRatio.
// Es la misma familia de matemática (Spring.ts ya la resuelve
// analíticamente, igual que _solveSpring en glassyflow.js), así que solo
// hace falta convertir parámetros: ω = sqrt(k/m), f = ω/2π, ζ = c/(2√(k·m)).
//
// Normal: stiffness 110, damping 15, mass 1 → f≈1.67Hz, ζ≈0.72 (rebote sutil).
// Fast (rap/coros con gap < 1.5s): stiffness 120, damping 18, mass 1 → f≈1.74Hz, ζ≈0.82.
export const GLASSY_SPRING = { frequency: 1.67, damping: 0.72 }
export const GLASSY_SPRING_FAST = { frequency: 1.74, damping: 0.82 }
