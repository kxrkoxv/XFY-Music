import { create } from 'zustand'
import type { NavigateFunction } from 'react-router-dom'

/**
 * Cuenta cuántas navegaciones "hacia adelante" (PUSH) hicimos dentro de la
 * SPA desde que se montó la app. Es la pieza que le faltaba a los
 * `navigate(-1)` desperdigados por cada página: ese `-1` asume que SIEMPRE
 * hay una entrada anterior DENTRO de la app, y eso es falso en los casos
 * más comunes de uso real —
 *
 *   1. La PWA instalada (manifest con display: "standalone") arranca
 *      SIEMPRE en start_url. Un deep link a /artist/x vía notificación,
 *      atajo del ícono o compartir no tiene nada "atrás" salvo el arranque
 *      mismo de la app.
 *   2. Al no haber chrome de navegador en standalone, tampoco hay gesto
 *      nativo de swipe-back del sistema — así que no hay red de seguridad
 *      del SO si la app intenta un `history.back()` sin stack propio.
 *
 * En esos casos el viejo `navigate(-1)` o hacía un `history.back()` que se
 * salía de la app (Android) o se quedaba sin hacer nada visible (iOS
 * standalone) — el botón "Volver" nefasto del que se quejaba el usuario.
 *
 * Con este contador, `smartGoBack` sólo usa `navigate(-1)` cuando de
 * verdad hay a dónde volver DENTRO de la SPA; si no, cae a una ruta
 * segura (Home por defecto) en vez de arriesgarse a salir de la app o
 * dejar al usuario clavado en la pantalla.
 */
interface BackStackState {
  depth: number
  markPush: () => void
  markPop: () => void
}

export const useBackStackStore = create<BackStackState>((set) => ({
  depth: 0,
  markPush: () => set((s) => ({ depth: s.depth + 1 })),
  markPop: () => set((s) => ({ depth: Math.max(0, s.depth - 1) })),
}))

/** true si hay al menos una navegación propia de la SPA para volver atrás. */
export function canGoBackInApp(): boolean {
  return useBackStackStore.getState().depth > 0
}

/**
 * Vuelve atrás "a lo iOS/Android": si hay stack propio, es un pop real
 * (navigate(-1), mismo historial, misma animación de vuelta). Si no lo
 * hay, en vez de arriesgar un `history.back()` que salga de la app o no
 * haga nada, navega a un destino conocido (Home por defecto) reemplazando
 * la entrada actual — así el usuario nunca queda pegado ni sale de XFY
 * sin querer.
 */
export function smartGoBack(navigate: NavigateFunction, fallback = '/') {
  if (canGoBackInApp()) navigate(-1)
  else navigate(fallback, { replace: true })
}
