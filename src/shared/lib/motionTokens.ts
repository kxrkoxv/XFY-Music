// Espejo JS de los tokens de motion de src/styles/tokens.css.
// En CSS usamos var(--ease-out); en motion/react los easings van como arrays,
// así que este módulo es la única fuente de verdad para no re-tipar los
// cubic-bezier a mano en cada componente (antes estaban duplicados en
// PlayerPage y MiniPlayerBar y se desincronizaban del token CSS).
export const EASE_OUT: [number, number, number, number] = [0.23, 1, 0.32, 1]
export const EASE_IN_OUT: [number, number, number, number] = [0.77, 0, 0.175, 1]
// Overshoot suave tipo "back" para pops pequeños (corazón, checks).
export const EASE_BACK: [number, number, number, number] = [0.34, 1.56, 0.64, 1]
// Spring para animaciones de layout (FLIP de motion): bloque entero
// cambiando de posición (letras ↔ sin letras en el player). Estilo Apple —
// duración fija con bounce bajito: suficiente para "acomodarse" sin rebote
// de juguete. Las transiciones de posición grandes piden spring, no tween:
// se sienten físicas y son interrumpibles a mitad de camino.
export const LAYOUT_SPRING = { type: 'spring', duration: 0.5, bounce: 0.18 } as const
