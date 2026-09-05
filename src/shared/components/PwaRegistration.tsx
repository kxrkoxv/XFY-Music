import { useEffect } from 'react'
import { toast } from 'sonner'
import { requestPersistentStorage } from '@shared/lib/cacheManager'
import { startReleaseWatch, sweepReleases, watchStatePayload } from '@shared/lib/releaseWatch'
import { ensurePushSubscription, syncPushWatchState } from '@shared/lib/pushNotifications'
import { showAppNotification } from '@shared/lib/appNotifications'
import { clearAppBadge } from '@shared/lib/appBadge'
import { usePlayerStore } from '@features/player'

// sessionStorage (no localStorage): sobrevive AL reload que dispara la
// propia actualización pero se limpia sola si el usuario cierra la
// pestaña/PWA — así el toast de "se actualizó" no puede quedar pendiente
// para siempre ni repetirse en una sesión futura sin sentido.
const JUST_UPDATED_KEY = 'xfy:just-updated'

// Misma idea que JUST_UPDATED_KEY: sessionStorage para que sobreviva SOLO
// al reload que nosotros mismos disparamos. Guardar el scroll antes de
// recargar y devolverlo después es la otra mitad de "que no se sienta" —
// un reload que te deja arriba de todo, aunque estabas a la mitad de una
// lista, ES un cambio que se nota igual que uno visual.
const SCROLL_RESTORE_KEY = 'xfy:scroll-before-reload'

// Clase que dispara el fundido de salida en global.css justo antes del
// reload real (ver applyUpdate). Sin esto, `window.location.reload()`
// corta la pantalla en seco de "app con la canción sonando" a blanco/negro
// de golpe — con la clase, hay un fundido corto al mismo fondo oscuro que
// ya usa AppLoader, así el corte se siente como una transición de carga
// más, no como que la app se rompió.
const RELOAD_FADE_CLASS = 'xfy-reloading'
const RELOAD_FADE_MS = 180

// Cada cuánto le preguntamos al navegador si hay un sw.js distinto al
// registrado (además de la revalidación en cada visible/online de abajo).
// Vercel sirve /sw.js con no-cache (ver vercel.json) así que esto es un
// fetch condicional barato, no una descarga completa cada vez.
const UPDATE_POLL_MS = 45 * 60 * 1000

// Si hay una versión nueva esperando pero la música nunca se pausa (radio
// de fondo todo el día), no la dejamos pendiente para siempre: a partir de
// este tiempo se aplica igual en el próximo momento en que la pestaña
// quede oculta, aceptando cortar el audio como último recurso.
const UPDATE_MAX_WAIT_MS = 3 * 60 * 60 * 1000

// Registro del service worker + ciclo de actualización + enganches de
// plataforma (push, periodic sync, badge). Todo best-effort: cualquier API
// ausente degrada a no-op sin romper la app.
//
// Actualizaciones — automáticas y silenciosas, pensadas para deploys de
// Vercel (un deploy nuevo puede borrar los chunks viejos del CDN, así que
// dejar una pestaña vieja corriendo mucho tiempo termina en "Failed to
// fetch dynamically imported module" al navegar a una ruta no visitada
// todavía):
//   1. Se detecta un sw.js nuevo (al registrar, por updatefound, o por el
//      poll/revalidación de abajo) → queda "waiting".
//   2. En vez de pedirle al usuario que la aplique con un click, se aplica
//      SOLA en el primer momento seguro: música pausada (o sin cola), o
//      —como último recurso, pasado UPDATE_MAX_WAIT_MS— la próxima vez que
//      la pestaña quede oculta. Nunca corta una canción sonando salvo ese
//      caso extremo.
//   3. Al aplicarla: postMessage SKIP_WAITING → el SW nuevo toma control →
//      controllerchange → UN solo reload. Si en ese instante la pestaña
//      está oculta, además se manda una notificación del sistema — si
//      está visible, el toast de confirmación al volver a cargar ya
//      avisa, así que una notificación encima sería ruido.
export default function PwaRegistration() {
  useEffect(() => {
    // Pide quedar afuera del desalojo automático de storage (ver
    // cacheManager.ts) — sin esto, el audio ya cacheado puede desaparecer
    // solo bajo presión de espacio o, en Safari, tras 7 días sin abrir la
    // app. Best-effort: si el navegador no lo concede, no rompe nada.
    requestPersistentStorage()

    // Vigilante de nuevos lanzamientos (notificaciones locales; ver
    // releaseWatch.ts). Internamente arranca con delay y respeta
    // permiso/toggle/ahorro de datos.
    startReleaseWatch()

    // Si esta carga es consecuencia de un reload que disparamos nosotros
    // por una actualización silenciosa, avisar UNA vez y limpiar la marca.
    try {
      if (sessionStorage.getItem(JUST_UPDATED_KEY) === '1') {
        sessionStorage.removeItem(JUST_UPDATED_KEY)
        toast.success('XFY se actualizó', {
          description: 'Ya estás en la última versión.',
        })
      }
      const savedScroll = sessionStorage.getItem(SCROLL_RESTORE_KEY)
      if (savedScroll !== null) {
        sessionStorage.removeItem(SCROLL_RESTORE_KEY)
        // 'auto', no smooth: esto es continuar exactamente donde estabas,
        // no una navegación — un scroll animado acá se leería como
        // movimiento nuevo, justo lo que se quiere evitar.
        window.scrollTo({ top: Number(savedScroll) || 0, behavior: 'auto' })
      }
    } catch {
      /* sessionStorage no disponible (modo privado estricto): no rompe nada */
    }

    // Badge del ícono limpio al abrir/volver a la app: lo que marcaba
    // "lanzamientos sin ver" ya se está viendo.
    void clearAppBadge()
    const onVisible = () => {
      if (document.visibilityState === 'visible') void clearAppBadge()
    }
    document.addEventListener('visibilitychange', onVisible)

    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [])

  useEffect(() => {
    if (!('serviceWorker' in navigator)) return undefined

    // En dev NO registramos el SW y además desregistramos cualquiera que
    // haya quedado de una sesión anterior: un SW con precache viejo sirve
    // módulos que ya no existen con MIME text/html y tira "Failed to fetch
    // dynamically imported module" que ni HMR arregla.
    if (import.meta.env.DEV) {
      navigator.serviceWorker.getRegistrations().then((regs) => {
        regs.forEach((r) => r.unregister())
      }).catch(() => {})
      return undefined
    }

    let applied = false
    let scheduled = false
    let stopWaiting: (() => void) | undefined

    // Dispara la actualización YA: SKIP_WAITING → controllerchange → un
    // único reload.
    const applyUpdate = (registration: ServiceWorkerRegistration): void => {
      if (applied || !registration.waiting) return
      applied = true
      stopWaiting?.()

      // Oculta en este instante = nadie mirando la pestaña ahora mismo:
      // es el único caso donde una notificación del sistema suma algo
      // (avisar que pasó, ya que no hay UI visible haciéndolo). Si está
      // visible, el toast post-reload de arriba ya cubre el aviso.
      void showAppNotification(
        {
          title: 'XFY se actualizó',
          body: 'Se aplicó sola una versión nueva.',
          tag: 'xfy-app-update',
        },
        { onlyWhenHidden: true },
      ).catch(() => {})

      try {
        sessionStorage.setItem(JUST_UPDATED_KEY, '1')
        sessionStorage.setItem(SCROLL_RESTORE_KEY, String(window.scrollY || 0))
      } catch {
        /* noop */
      }

      let reloaded = false
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (reloaded) return
        reloaded = true
        // Fundido corto ANTES del reload en vez de un reload seco: la
        // pantalla se apaga suave al mismo negro de fondo que ya usa
        // AppLoader, y del otro lado arranca la misma marca — un solo
        // gesto continuo de "cargando" en vez de un corte + una pantalla
        // distinta. document.documentElement, no #root: el reload va a
        // destruir el documento entero en un instante, así que conviene
        // que el fundido no dependa de que React siga vivo para pintarlo.
        document.documentElement.classList.add(RELOAD_FADE_CLASS)
        window.setTimeout(() => window.location.reload(), RELOAD_FADE_MS)
      })
      registration.waiting.postMessage({ type: 'SKIP_WAITING' })
    }

    // Espera a que sea seguro aplicar: nada sonando ahora mismo, o —pasado
    // el máximo tolerado— la próxima vez que la pestaña se oculte.
    const scheduleSilentUpdate = (registration: ServiceWorkerRegistration): void => {
      if (!registration.waiting || scheduled || applied) return
      scheduled = true

      const isSafeNow = (): boolean => !usePlayerStore.getState().isPlaying
      if (isSafeNow()) {
        applyUpdate(registration)
        return
      }

      const detectedAt = Date.now()
      const pastDeadline = () => Date.now() - detectedAt >= UPDATE_MAX_WAIT_MS
      const onPlayerChange = (state: { isPlaying: boolean }, prev: { isPlaying: boolean }) => {
        if (state.isPlaying !== prev.isPlaying && isSafeNow()) applyUpdate(registration)
      }
      const onHiddenPastDeadline = () => {
        if (document.visibilityState !== 'visible' && pastDeadline()) applyUpdate(registration)
      }
      // Red de seguridad: lo de arriba solo reacciona a un EVENTO de
      // visibilitychange después del plazo. Si la pestaña queda abierta y
      // en primer plano sin interrupciones (radio de fondo todo el día,
      // el caso que motivó esto: la PWA nunca pasa a segundo plano y la
      // UI vieja queda pegada indefinidamente), ese evento puede no
      // llegar nunca. Este poll revisa el reloj igual, sin depender de
      // que pase nada — pasado el plazo, se aplica en la próxima ventana seguro
      // (pausa) y si tampoco eso llega en un tiempo razonable, se fuerza.
      const pollId = window.setInterval(() => {
        if (applied) return
        if (isSafeNow() && pastDeadline()) {
          applyUpdate(registration)
        } else if (Date.now() - detectedAt >= UPDATE_MAX_WAIT_MS * 2) {
          // Último recurso: el doble del plazo ya pasó y seguimos sonando
          // en primer plano sin pausa — se aplica igual, como documenta
          // el comentario de arriba ("cortar el audio como último recurso").
          applyUpdate(registration)
        }
      }, 60 * 1000)

      const unsubscribePlayer = usePlayerStore.subscribe(onPlayerChange)
      document.addEventListener('visibilitychange', onHiddenPastDeadline)
      stopWaiting = () => {
        unsubscribePlayer()
        document.removeEventListener('visibilitychange', onHiddenPastDeadline)
        window.clearInterval(pollId)
      }
    }

    const onMessage = (event: MessageEvent): void => {
      if (event.data?.type === 'XFY_RUN_RELEASE_SWEEP') {
        // Despertado por periodic background sync del SW (Chromium, PWA
        // instalada). sweepReleases respeta sus gaps internos, así que
        // despertar más seguido no genera spam de requests.
        void sweepReleases().catch(() => {})
      }
    }
    navigator.serviceWorker.addEventListener('message', onMessage)

    let currentRegistration: ServiceWorkerRegistration | null = null
    const checkForUpdate = (): void => {
      void currentRegistration?.update().catch(() => {})
    }

    const register = (): void => {
      navigator.serviceWorker
        .register('/sw.js')
        .then(async (registration) => {
          currentRegistration = registration

          // ¿Ya había uno esperando al registrar (update bajado en sesión previa)?
          scheduleSilentUpdate(registration)

          registration.addEventListener('updatefound', () => {
            const installing = registration.installing
            if (!installing) return
            installing.addEventListener('statechange', () => {
              if (installing.state === 'installed' && navigator.serviceWorker.controller) {
                scheduleSilentUpdate(registration)
              }
            })
          })

          // Push: si el permiso de notificaciones YA está concedido,
          // suscribir silenciosamente (iOS exige PWA instalada; el helper
          // lo gatea). Fire-and-forget.
          if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
            const result = await ensurePushSubscription()
            if (result === 'subscribed') {
              // Primera sincronización de estado inmediata para que el cron
              // tenga qué vigilar sin esperar el primer sweep local.
              await syncPushWatchState(watchStatePayload(), { force: true })
            }
          }

          // Periodic Background Sync: registro best-effort (solo Chromium
          // con PWA instalada; el navegador decide si concede el intervalo).
          const anyReg = registration as ServiceWorkerRegistration & {
            periodicSync?: { register(tag: string, options?: { minInterval: number }): Promise<void> }
          }
          try {
            await anyReg.periodicSync?.register('xfy-release-watch', { minInterval: 12 * 60 * 60 * 1000 })
          } catch {
            /* sin soporte o rechazado: el cron server-side cubre ese caso */
          }
        })
        .catch(console.error)
    }

    // El browser solo revisa /sw.js por su cuenta en navegaciones (y a
    // veces con horas de demora). Estos tres disparadores cubren el resto:
    // reabrir la PWA, volver de background, y recuperar conexión —
    // exactamente los momentos en que es más probable que haya pasado un
    // deploy sin que esta pestaña se enterara.
    const onVisibleCheck = () => {
      if (document.visibilityState === 'visible') checkForUpdate()
    }
    document.addEventListener('visibilitychange', onVisibleCheck)
    window.addEventListener('online', checkForUpdate)
    const pollId = window.setInterval(checkForUpdate, UPDATE_POLL_MS)

    if (document.readyState === 'complete') {
      register()
    } else {
      window.addEventListener('load', register)
    }

    return () => {
      window.removeEventListener('load', register)
      navigator.serviceWorker.removeEventListener('message', onMessage)
      document.removeEventListener('visibilitychange', onVisibleCheck)
      window.removeEventListener('online', checkForUpdate)
      window.clearInterval(pollId)
      stopWaiting?.()
    }
  }, [])

  return null
}
