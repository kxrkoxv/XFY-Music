# XFY

Reproductor de música construido con React + Vite + **TypeScript (strict)**,
con el catálogo y la búsqueda basados en YouTube Music.

## Stack

- **Vite + React 19 + TypeScript strict** — build estático, sin servidor propio para el frontend. `npm run typecheck` (doble pasada: app + node) en CI.
- **Zustand** (`*/store/`) — estado global: sesión, reproductor, portadas.
- **Motion** (`motion/react`) — animaciones de UI.
- **Base UI** (`@base-ui/react`) — componentes accesibles sin estilos que pelear.
- **Sonner** — notificaciones.
- **Lucide / Morphicons / AnimateIcons** — iconografía.
- **React Router 7** (`HashRouter`) — enrutamiento de páginas.
- **hls.js** — streams HLS (Audius / Motion Art).
- **oxlint** — linting. **Vitest + Testing Library** — tests.
- **@use-gesture/react** — gestos de la tab bar (drag-to-select).

## Estado de la migración TypeScript

**Migración completa.** Todo el código del proyecto está en TypeScript
(strict, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`): `src/`,
las Vercel Functions de `api/` (chequeadas por `tsconfig.node.json`)
y `vite.config.ts`. Patrones en uso: branded types (`VideoId`,
`SongKey` en `audioCacheKey.ts`), template literal types para las rutas
del Blob store, `satisfies` en catálogos, contratos de dominio en
`src/types/models.ts`. El service worker está en `src/sw.ts` (TypeScript)
y se compila por `vite-plugin-pwa` con estrategia `injectManifest`;
el archivo resultante se sirve desde `dist/sw.js`.

## De dónde sale cada cosa

- **Búsqueda y catálogo**: YouTube Music, vía `ytmusic-api` corriendo dentro
  de una función serverless de Vercel (`api/ytmusic.ts`). En desarrollo,
  un plugin de `vite.config.ts` ejecuta ESA MISMA Function dentro del
  server de Vite, así que `vite dev` se comporta igual que producción.
- **Reproducción**: caché de audio compartida en Vercel Blob, servida por
  CDN. Al pedir una canción, el frontend (`ytblob.ts`) primero hace HEAD
  al blob (`yt-audio/{videoId}.m4a|webm`); si ya existe, suena directo
  por `<audio>` nativo. Si no, arranca de inmediato por el IFrame Player
  (`YouTubeEngine.tsx`, latencia cero) y dispara en paralelo
  `POST /api/ytcache`, que extrae el audio (youtubei.js + PO tokens
  BotGuard, ver `api/_lib/ytcore.ts`) y lo sube al blob en background
  (`waitUntil`); el frontend hace polling del HEAD y avisa cuando está
  listo para la próxima escucha. Las pistas externas (Audius) usan
  hls.js (`AudioEngine.tsx`).
- **Segundo plano (2026)**: YouTube bloquea su player en background desde
  el server (ene-2026), así que la ruta IFrame es SOLO arranque visible;
  el escape real es el blob propio (`<audio>` + MediaSession + Audio
  Session `playback`). El polling del upgrade y el watchdog de
  auto-sanación corren en un Web Worker (`workerTicker.ts`) porque los
  timers de pestaña oculta se recortan a ~1/min; si WebKit deja el
  `<audio>` zombie (iOS 26 PWA reopen, bug 295518) el elemento se
  RECREA con el mismo src — cura documentada.
- **Portadas e info de artista**: iTunes Search API, TheAudioDB,
  MusicBrainz/CoverArtArchive, Deezer y Wikipedia como fuentes
  complementarias cuando YouTube Music no trae datos completos
  (proxies en `vercel.json`, `api/musicbrainz.ts`, `api/imgproxy.ts`;
  clientes en `src/services/api/`).
- **Letras**: LRCLIB (`src/features/lyrics/engine/lrclib.ts`), con fallback a
  las letras propias de YouTube Music. La asignación es tolerante a ruido
  de títulos ("(Official Video)", "feat. X"…) y rechaza candidatos con
  duración imposible (>10s de desvío) para no asignarle a una canción la
  letra de otra versión. El timing palabra-a-palabra sale del **Enhanced
  LRC** que LRCLIB trae para muchísimos tracks (timestamps por palabra
  reales, badge "PALABRA A PALABRA"); el resto se estima con un
  distribuidor silábico (`wordTiming.ts`) — 100% en Vercel + cliente,
  sin servicios externos ni claves. Todo cacheado durable en IndexedDB.
- **Video/arte de fondo del reproductor**: portadas animadas estilo
  Apple Music generadas bajo demanda (`api/motionart.ts`) y cacheadas
  localmente.
- **Autenticación y playlists**: 100% locales, en IndexedDB
  (`src/shared/lib/db.ts`), sin backend de usuarios.
- **Nuevos lanzamientos**: cada 6 h el cliente revisa iTunes por los
  artistas que más escuchaste en los últimos 30 días (todo local, ver
  `src/shared/lib/releaseWatch.ts`) y avisa con notificación del sistema
  si hay álbum o canción nueva (`src/shared/lib/appNotifications.ts`).
  Primera vez = solo línea base (cero spam), toggle en Configuración.
  Las notificaciones locales también cubren eventos como "audio listo
  para segundo plano" cuando la app está oculta.
- **Push con la app cerrada**: un cron diario en Vercel (`api/push/cron-release-watch.ts`)
  consulta iTunes por los artistas vigilados de cada dispositivo suscrito
  y les envía push vía Web Push (VAPID) aunque la app esté cerrada.
  La suscripción es opcional, anónima (token por dispositivo) y requiere
  permiso de notificaciones concedido + PWA instalada (iOS 16.4+).
- **Wake Lock**: en modo cinema o con letras karaoke sonando, la pantalla
  se mantiene encendida automáticamente (`useScreenWakeLock.ts`).

## Estructura del proyecto

```
api/                  Funciones serverless de Vercel (TypeScript)
  ytmusic.ts            Búsqueda/catálogo/letras de YT Music (ytmusic-api)
  ytcache.ts            Extracción de audio de YT + upload a Vercel Blob
                          (caché compartido, dedupe inflight, waitUntil)
  ytaudio.ts            Extracción de audio para el player (hls.js)
  ytstream.ts           Streaming de audio HLS
  ytaudit.ts            Auditoría de integridad del caché de audio (manual,
                          ADMIN_TOKEN) + eviction LRU vía Vercel Cron cada
                          3 días (mismo archivo, fusionados por el tope de
                          12 Serverless Functions del plan Hobby)
  push.ts               Endpoint unificado push (subscribe/state/unsubscribe)
  push/cron-release-watch.ts  Cron diario de push de lanzamientos
  _lib/ytcore.ts        Núcleo compartido: sesión Innertube, BotGuard,
                          minteo de PO tokens, extracción de audio
  _lib/ytstore.ts       Caché de audio en Vercel Blob (índice, metadata, LRU)
  _lib/remux.ts         Reempaquetado MP4/WebM → contenedor progresivo
  motionart.ts          Portadas animadas (HLS) estilo Apple Music
  imgproxy.ts           Proxy de imágenes externas (CORS/mixed-content)
  musicbrainz.ts        Proxy MusicBrainz (necesita User-Agent propio)
  cron/                 Crons programados (auditoría + push de lanzamientos)
public/                Assets estáticos e íconos PWA
src/
  main.tsx / App.tsx    Arranque, rutas y engines globales
  sw.ts                 Service worker (injectManifest, precache + push/periodicSync)
  features/             Un dominio por carpeta (components/, store/, lib/)
    auth/                 Sesión local (login, restore, preferencias)
    catalog/              HomePage, DiscoverPage, búsqueda
    player/               Reproducción: engines, cola, MiniPlayerBar, MediaSession
    lyrics/               Letras sincronizadas por palabra (motor karaoke)
    artists/              Páginas de artista y álbum, discografías
    playlists/            Playlists locales + importación desde YT Music
    settings/             Temas, almacenamiento y caché
  services/api/         Un cliente por fuente externa (ytmusic, audius,
                        itunes, deezer, audiodb, musicbrainz, wikipedia…)
  shared/
    components/           UI transversal (Sidebar, MobileTabBar,
                            ErrorBoundary, PWA, CachedImg…)
    lib/                  cacheManager (LRU sobre Cache Storage),
                            db (IndexedDB), requestCache, hooks varios
                            appBadge.ts, useScreenWakeLock.ts,
                            pushNotifications.ts, appIntents.ts
  styles/               Estilos globales
```

Los imports usan aliases absolutos definidos en `vite.config.ts`:
`@` → `src/`, `@features`, `@shared`, `@services`.

## Desplegar en producción

Pensado para **Vercel**.

- **Framework Preset:** Vite
- **Build Command:** `npm run build`
- **Output Directory:** `dist`
- **Install Command:** `npm install`

`vercel.json` define los rewrites hacia iTunes/TheAudioDB/LRCLIB/Deezer/
MusicBrainz/CoverArtArchive y los límites de duración de las funciones en `api/`.
`api/ytcache.ts` usa `maxDuration: 300` (el tope real de Hobby con Fluid
Compute) porque extrae audio + lo descarga + lo sube al blob en una sola
invocación; con menos, cortaba el job a mitad de camino en frío (ver
`FUNCTION_INVOCATION_TIMEOUT` en los logs de Runtime si esto vuelve a pasar).

### Variables de entorno

- **Store de Blob conectado** — requisito para el caché de audio
  (`api/ytcache.ts`). Se conecta desde Storage → `xfy-music-blob` →
  Projects → Connect to Project (o al crearlo). Por default, Vercel
  conecta el store vía **OIDC** (inyecta `BLOB_STORE_ID` +
  `VERCEL_OIDC_TOKEN`, este último rotado automáticamente en cada
  deploy) — el SDK de `@vercel/blob` los usa solo, sin configurar nada
  más. Como fallback también podés usar el token estático
  `BLOB_READ_WRITE_TOKEN` (Advanced Options al conectar, o agregado a
  mano en Settings → Environment Variables) si preferís no depender de
  OIDC. Sin ninguna de las dos vías, `/api/ytcache` responde
  `503 unconfigured` y la app sigue funcionando igual, solo que cada
  reproducción vuelve a arrancar por el IFrame en vez de servir desde el
  Blob CDN. El store público usado en este proyecto es `xfy-music-blob`
  (base URL `https://3xdosg72gxp3tqbf.public.blob.vercel-storage.com`,
  configurable en el frontend vía `VITE_BLOB_BASE_URL` si se recrea el
  store con otro ID).

#### Opcionales

- `YTMUSIC_COOKIE` — cookie de una sesión real de YouTube Music, solo si
  `api/ytmusic.ts` empieza a recibir bloqueos consistentes desde las IPs
  de Vercel.
- `YTDL_COOKIE` — cookie para la extracción de audio (`api/_lib/ytcore.ts`).
  Es el fix definitivo cuando YouTube challengea las IPs de datacenter de
  Vercel ("Sign in to confirm you're not a bot" → todos los clientes caen a
  playability LOGIN_REQUIRED). Cómo armarla: en un navegador logueado a
  YouTube, DevTools → Application → Cookies → `https://www.youtube.com`, y
  copiar al menos `VISITOR_INFO1_LIVE`, `YSC`, `SID`, `HSID`, `SSID`,
  `SAPISID` como `"name=value; name=value; ..."`. Setearla en Vercel →
  Settings → Environment Variables y redeployar. Sin cookie el resolutor
  igual se defiende (rebuild de sesión + cadena YTMUSIC→MWEB→ANDROID_VR→TV),
  pero es cat y mouse; con cookie es estable.
- `YT_AUDIO_CLIENT` — cliente Innertube a usar en la extracción
  (default `YTMUSIC`, con fallback interno a `TV`).
- `YT_PROXY_URL` — proxy residencial/móvil (`http://usuario:password@host:puerto`)
  para el tráfico saliente de `api/_lib/ytcore.ts`. Es la mitigación real
  contra el bloqueo por REPUTACIÓN DE IP de datacenter (Vercel, Render,
  AWS...) — un problema distinto al challenge anti-bot que resuelven
  `YTDL_COOKIE`/PO Tokens: ese bloqueo actúa antes de mirar la sesión, así
  que ninguna cookie lo esquiva. Sin esta var, el resolutor sigue
  funcionando exactamente igual que hoy (no-op). Requiere contratar un
  proveedor de proxies residenciales (Webshare, Bright Data, IPRoyal,
  Smartproxy...); no hay forma de conseguir esto gratis de forma confiable.

#### Push (opcional)

- `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` — par de claves VAPID para Web Push
  (generar con `npx web-push generate-vapid-keys`; la pública va en
  `VITE_VAPID_PUBLIC_KEY` para el cliente).
- `CRON_SECRET` — opcional, Bearer token para disparar el cron de push
  manualmente (`Authorization: Bearer <CRON_SECRET>`).

## Caché inteligente (`src/shared/lib/cacheManager.ts`)

- **Audio de YouTube**: no pasa por acá — vive en el Blob CDN compartido
  (`api/ytcache.ts` / `ytblob.ts`), ver sección de Reproducción arriba.
- **Audio externo (Audius) y otros assets**: se guardan en Cache Storage
  API la primera vez que se reproducen/muestran. Cupo fijo (500 MB) con
  borrado LRU automático al superarlo.
- **Metadatos** (portadas, bios, letras, discografías): cachés pequeños en
  `localStorage` con TTL de horas a días según la fuente.
- Todo es visible y se puede vaciar manualmente desde
  Configuración → Almacenamiento y caché.

## PWA — características extra

- **Install prompt** nativo + botón "Reintentar" en error boundary.
- **Share Target**: compartí un link de YouTube desde cualquier app → XFY lo resuelve y reproduce.
- **File Handling**: abrís un `.mp3/.m4a/.ogg/.flac` "con XFY" → suena directo.
- **Periodic Background Sync** (Chromium, PWA instalada): refresca el release watch cada ~12 h.
- **Badging API**: puntito en el ícono cuando hay lanzamientos sin ver; se limpia al abrir.
- **Wake Lock**: pantalla encendida en modo cinema / letras karaoke.
- **Prompt de actualización**: toast "Hay una versión nueva — Recargar" (SKIP_WAITING manual).
- **Eviction LRU del caché de audio**: cron de auditoría (cada 3 días) desaloja audios más viejos si pasa de 850 MB, baja a 700 MB; costo ≈ 1 `list` + `del` justos; índices huérfanos se auto-reparan.

## Comandos

```bash
npm install
npm run dev      # desarrollo (plugin interno replica la API de YT Music)
npm run test     # vitest
npm run lint     # oxlint
npm run build    # build de producción → dist/
```
