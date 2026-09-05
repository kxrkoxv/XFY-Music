import { lazy } from 'react'
import type { ComponentType, LazyExoticComponent } from 'react'

const RELOAD_FLAG_PREFIX = 'xfy_chunk_retry_'

/**
 * Envuelve React.lazy() para sobrevivir a un fallo de carga de chunk
 * dinámico ("Failed to fetch dynamically imported module" / chunk 404) —
 * típico justo después de un deploy, cuando la pestaña sigue con un
 * index.html viejo que apunta a hashes de archivo que el servidor ya no
 * tiene. Sin esto, ese fallo tiraba el ErrorBoundary global (se pierde el
 * reproductor y el estado de toda la app) o dejaba la ruta en blanco, y
 * para quien está navegando eso se ve exactamente como "esta página no
 * quiso cargar" sin ninguna forma de recuperarse salvo adivinar que hay
 * que refrescar a mano.
 *
 * Estrategia: si el import() falla, se asume chunk desactualizado y se
 * hace UN recargue completo (trae index.html + manifest nuevos, que
 * resuelve el caso normal). `sessionStorage` evita un loop de recargas si
 * el fallo no era por eso (ej. la red está realmente caída) — ahí el
 * segundo fallo sí se propaga para que lo agarre el ErrorBoundary de ruta
 * y el usuario vea un mensaje con botón de "Reintentar" en vez de un
 * refresh infinito.
 */
export function lazyWithRetry<T extends ComponentType<unknown>>(
  importFn: () => Promise<{ default: T }>,
  chunkName: string,
): LazyExoticComponent<T> {
  const flagKey = `${RELOAD_FLAG_PREFIX}${chunkName}`
  return lazy(async () => {
    try {
      const mod = await importFn()
      sessionStorage.removeItem(flagKey)
      return mod
    } catch (err) {
      let alreadyRetried = false
      try {
        alreadyRetried = sessionStorage.getItem(flagKey) === '1'
      } catch {
        // sessionStorage no disponible (modo privado, etc.) — no se puede
        // rastrear el reintento, así que se salta directo al throw de abajo.
        alreadyRetried = true
      }
      if (!alreadyRetried) {
        try {
          sessionStorage.setItem(flagKey, '1')
        } catch {
          // no crítico
        }
        window.location.reload()
        // El recargue ya está en camino — cuelga la promesa a propósito
        // para que React no alcance a pintar un estado de error un
        // instante antes de que la página se recargue sola.
        await new Promise(() => {})
      }
      try {
        sessionStorage.removeItem(flagKey)
      } catch {
        // no crítico
      }
      throw err
    }
  })
}
