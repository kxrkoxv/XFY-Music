/// <reference lib="webworker" />
// ============================================================
// Service worker de XFY (TypeScript, compilado por vite-plugin-pwa
// con estrategia injectManifest — ver VitePWA() en vite.config.ts).
//
// El plugin inyecta en build time la lista COMPLETA de assets del
// bundle (sw.__WB_MANIFEST): antes el shell era una lista hardcoded
// y los chunks con hash solo entraban al caché después de la primera
// visita online. Ahora la PWA es offline desde la PRIMERA carga.
//
// Estrategias por tipo de recurso (mismas que tenía el sw.js manual):
//  - Navegaciones: network-first con fallback al shell cacheado.
//  - Assets del build (hash de contenido): cache-first + relleno runtime.
//  - Otros archivos propios (/public): stale-while-revalidate.
//  - /api/* y hosts externos: NO se tocan — requestCache/cacheManager ya
//    tienen su propia lógica de TTL/cupo/LRU encima.
//
// Updates: NADA de skipWaiting automático DESDE EL SW — sigue siendo la
// página (PwaRegistration) quien decide cuándo es seguro pedirlo. La
// diferencia con antes: ya no espera un click en un toast "Recargar" que
// podía quedar ahí semanas — aplica sola en el primer momento seguro
// (música pausada) y solo entonces manda SKIP_WAITING acá abajo.
// ============================================================

// Con las libs DOM+WebWorker cargadas juntas, el global `self` resuelve a
// Window y rompe el tipado de los handlers del worker. Un alias casteado
// por archivo evita esa pelea sin tocar el resto del programa.
const sw = self as unknown as ServiceWorkerGlobalScope

/** Entradas del precache manifest que inyecta workbox-build en build time.
 * El punto de inyección es `globalThis.__WB_MANIFEST` (ver injectionPoint en
 * vite.config.ts): workbox reemplaza ESA expresión completa por el array
 * literal de entradas — `globalThis` sobrevive la minificación, un alias
 * local como `sw` sería renombrado y el match del string fallaría. */
interface ManifestEntry {
  url: string
  revision?: string | null
}
function injectedManifest(): ManifestEntry[] {
  return (globalThis as { __WB_MANIFEST?: ManifestEntry[] }).__WB_MANIFEST ?? []
}

const SHELL_CACHE = 'xfy-shell-v3'

interface SharePayload {
  title?: string
  body?: string
  url?: string
  tag?: string
}

/** URLs precacheadas por el plugin en build time (todos los assets del dist). */
function precacheUrls(): string[] {
  return injectedManifest().map((entry) => entry.url)
}

sw.addEventListener('install', (event: ExtendableEvent) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE)
      // addAll falla ENTERO si un solo asset falta; mejor uno por uno y
      // dejar que lo crítico (index.html) decida: si ese falla, igual
      // guardamos lo que sí bajó para no tirar el offline a la basura.
      await Promise.allSettled(
        precacheUrls().map(async (url) => {
          try {
            await cache.add(new Request(url, { cache: 'reload' }))
          } catch {
            /* asset individual caído: no aborta la instalación */
          }
        }),
      )
      // Fallback duro de navegación offline: si index.html no entró por la
      // lista (p. ej. build parcial), intentamos traerlo directo.
      if (!(await cache.match('/index.html'))) {
        try {
          await cache.put('/index.html', await fetch(new Request('/', { cache: 'reload' })))
        } catch {
          /* sin red en la primera visita: no hay nada que precachear */
        }
      }
    })(),
  )
})

sw.addEventListener('activate', (event: ExtendableEvent) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key.startsWith('xfy-shell-') && key !== SHELL_CACHE)
          .map((key) => caches.delete(key)),
      ),
    ),
  )
  void sw.clients.claim()
})

function isBuildAsset(pathname: string): boolean {
  // Los archivos que emite Vite en /assets/ llevan hash de contenido:
  // inmutables por definición, cache-first sin riesgo de staleness.
  return pathname.startsWith('/assets/')
}

sw.addEventListener('fetch', (event: FetchEvent) => {
  const { request } = event
  if (request.method !== 'GET') return

  const url = new URL(request.url)

  // API propia y hosts externos (streams, thumbnails, YouTube): directo a
  // red — requestCache.js y cacheManager.js ya manejan su propio caché.
  if (url.pathname.startsWith('/api/') || url.origin !== sw.location.origin) return

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone()
          void caches.open(SHELL_CACHE).then((cache) => cache.put('/index.html', copy))
          return response
        })
        .catch(() => caches.match('/index.html').then((hit) => hit ?? Response.error())),
    )
    return
  }

  if (isBuildAsset(url.pathname)) {
    event.respondWith(
      caches.match(request).then(
        (cached) =>
          cached ??
          fetch(request).then((response) => {
            const copy = response.clone()
            void caches.open(SHELL_CACHE).then((cache) => cache.put(request, copy))
            return response
          }),
      ),
    )
    return
  }

  // Resto de archivos same-origin (íconos, manifest, screenshots):
  // stale-while-revalidate — respuesta instantánea del caché + refresco
  // silencioso para la próxima vez.
  if (url.origin === sw.location.origin) {
    event.respondWith(
      caches.match(request).then((cached) => {
        const network = fetch(request)
          .then((response) => {
            const copy = response.clone()
            void caches.open(SHELL_CACHE).then((cache) => cache.put(request, copy))
            return response
          })
          .catch(() => cached ?? Response.error())
        return cached ?? network
      }),
    )
  }
})

// --- Actualizaciones dirigidas -------------------------------------------
// PwaRegistration detecta un SW waiting, espera el primer momento seguro
// (música pausada, ver UPDATE_MAX_WAIT_MS) y recién ahí manda esto →
// skipWaiting → controllerchange → reload único desde la página.
sw.addEventListener('message', (event: ExtendableMessageEvent) => {
  if (event.data?.type === 'SKIP_WAITING') void sw.skipWaiting()
})

// --- Notificaciones push ---------------------------------------------------
// La mitad que le toca al SW: recibir el payload con la app CERRADA y
// mostrarlo como notificación del sistema. Suscripción/envío viven en
// shared/lib/pushNotifications.ts + api/push/*.
sw.addEventListener('push', (event: PushEvent) => {
  if (!event.data) return
  let payload: SharePayload
  try {
    payload = event.data.json() as SharePayload
  } catch {
    payload = { title: 'XFY', body: event.data.text() }
  }
  const { title = 'XFY', body, url = '/', tag } = payload
  event.waitUntil(
    sw.registration.showNotification(title, {
      body,
      tag,
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      data: { url },
    }),
  )
})

sw.addEventListener('notificationclick', (event: NotificationEvent) => {
  event.notification.close()
  const targetUrl = event.notification.data?.url || '/'
  event.waitUntil(
    sw.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientsList) => {
      const existing = clientsList.find((c) => c.url.includes(sw.location.origin))
      if (existing) return existing.focus()
      return sw.clients.openWindow(targetUrl)
    }),
  )
})

// --- Periodic Background Sync (Chromium, PWA instalada) --------------------
// Chrome despierta este handler ~cada minInterval cuando hay conectividad.
// No puede ejecutar la barrida de releaseWatch acá adentro (el estado vive
// en localStorage/métricas de la página), así que le avisa a las ventanas
// abiertas vía postMessage — PwaRegistration corre sweepReleases al
// recibirlo. Con todo cerrado, el cron server-side (api/push/cron-release-
// watch.ts) es quien cubre el chequeo diario.
sw.addEventListener('periodicsync', ((event: ExtendableEvent & { tag?: string }) => {
  if (event.tag !== 'xfy-release-watch') return
  event.waitUntil(
    sw.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientsList) => {
      for (const client of clientsList) {
        client.postMessage({ type: 'XFY_RUN_RELEASE_SWEEP' })
      }
    }),
  )
}) as EventListener)
