import { Suspense, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { HashRouter, Routes, Route, Navigate, useLocation, useNavigate, useNavigationType } from 'react-router-dom'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import type { Variants } from 'motion/react'
import { Toaster, toast } from 'sonner'
import { CheckCircle2, XCircle, AlertTriangle, Info, Loader2 } from 'lucide-react'
import '@shared/components/AppToaster.css'
import './App.css'
import { useBackStackStore, smartGoBack } from '@shared/lib/backStack'
import { useEdgeSwipeBack } from '@shared/lib/useEdgeSwipeBack'
import { useAuthStore, AuthPage } from '@features/auth'
import { usePlaylistsStore } from '@features/playlists'
import { useSpotifyConnectStore } from '@features/playlists/store/useSpotifyConnectStore'
import { completeSpotifyLogin, fetchSpotifyProfile } from '@services/api/spotifyAuth'
import { appDB, type SpotifyAuthPrefs } from '@shared/lib/db'
import {
  usePlayerStore,
  AudioEngine,
  YouTubeEngine,
  MediaSessionSync,
  MiniPlayerBar,
} from '@features/player'
import { applyTheme } from '@features/settings'
import { applyGlassClarity, isValidGlassClarity } from '@features/settings/lib/glassClarity'
import { useCustomThemesStore } from '@features/settings/lib/customThemesStore'
import { HomePage } from '@features/catalog'
import { sweepHeavyRotation } from '@features/player/lib/smartCache'
import { warmHomeCatalogCache } from '@features/catalog/lib/homePrecache'
import { pruneAgedAssets } from '@shared/lib/cacheManager'
import AppLoader from '@shared/components/AppLoader'
import PwaRegistration from '@shared/components/PwaRegistration'
import PwaInstallPrompt from '@shared/components/PwaInstallPrompt'
import NotificationPermissionPrompt from '@shared/components/NotificationPermissionPrompt'
import ErrorBoundary from '@shared/components/ErrorBoundary'
import MobileTabBar from '@shared/components/MobileTabBar'
import useMediaKeyboardShortcuts from '@shared/lib/useMediaKeyboardShortcuts'
import useWindowControlsOverlay from '@shared/lib/useWindowControlsOverlay'
import { consumeSharedTarget, initFileHandlers } from '@shared/lib/appIntents'
import { lazyWithRetry } from '@shared/lib/lazyWithRetry'
import { registerBuiltinSources } from '@services/plugins'

// Registro de plugins de fuente de música (YT Music, Audius, Piped) —
// se hace una vez al cargar el módulo, antes de que cualquier componente
// necesite listarlos (ver Ajustes → Fuentes).
registerBuiltinSources()

/**
 * Eagerly load critical first-paint routes. Other routes are lazy-loaded to
 * reduce initial bundle size, vía lazyWithRetry en vez de React.lazy() a
 * secas: si el chunk falla (típico justo después de un deploy, cuando el
 * navegador sigue apuntando a un index.html con hashes viejos), reintenta
 * una vez con un recargue completo en vez de dejar la ruta en blanco o
 * tirar abajo toda la app. Ver lazyWithRetry.js.
 */
const ArtistsPage = lazyWithRetry(() => import('@features/artists/components/ArtistsPage'), 'artists-page')
const ArtistPage = lazyWithRetry(() => import('@features/artists/components/ArtistPage'), 'artist-page')
const AlbumPage = lazyWithRetry(() => import('@features/artists/components/AlbumPage'), 'album-page')
const PlayerPage = lazyWithRetry(() => import('@features/player/components/PlayerPage'), 'player-page')
const DiscoverPage = lazyWithRetry(() => import('@features/catalog/components/DiscoverPage'), 'discover-page')
const PlaylistsPage = lazyWithRetry(() => import('@features/playlists/components/PlaylistsPage'), 'playlists-page')
const PlaylistDetailPage = lazyWithRetry(() => import('@features/playlists/components/PlaylistDetailPage'), 'playlist-detail-page')
const SettingsPage = lazyWithRetry(() => import('@features/settings/components/SettingsPage'), 'settings-page')
const WrappedPage = lazyWithRetry(() => import('@features/wrapped/components/WrappedPage'), 'wrapped-page')
const BlendPage = lazyWithRetry(() => import('@features/wrapped/components/BlendPage'), 'blend-page')

function RequireAuth({ children }: { children: ReactNode }) {
  const { currentUser, status } = useAuthStore()
  if (status !== 'ready') return null
  if (!currentUser) return <Navigate to="/login" replace />
  return children
}

function RedirectIfAuthed({ children }: { children: ReactNode }) {
  const { currentUser, status } = useAuthStore()
  if (status !== 'ready') return null
  if (currentUser) return <Navigate to="/" replace />
  return children
}

/**
 * Variants de Framer Motion para la transición de página — con dirección:
 * `custom` (1 = avanzar/PUSH, -1 = volver/POP) decide de qué lado entra y
 * hacia dónde sale, calcado del comportamiento de UINavigationController /
 * Android: avanzar entra desde la derecha, volver entra desde la
 * izquierda — nunca la misma animación para las dos direcciones, que es
 * lo que hacía sentir "plano" al sistema de navegación viejo (todo
 * fade+scale sin importar si ibas para adelante o para atrás).
 */
const pageVariants: Variants = {
  initial: (direction: 1 | -1) => ({
    opacity: 0,
    x: direction === -1 ? -18 : 18,
    y: 6,
    scale: 0.985,
  }),
  animate: {
    opacity: 1,
    x: 0,
    y: 0,
    scale: 1,
    transition: { type: 'spring', stiffness: 420, damping: 34, mass: 0.9 },
  },
  exit: (direction: 1 | -1) => ({
    opacity: 0,
    x: direction === -1 ? 18 : -18,
    y: -4,
    scale: 0.99,
    transition: { duration: 0.14, ease: [0.4, 0, 1, 1] },
  }),
}

/** Headless component for binding global media keyboard shortcuts within the router context. */
function GlobalMediaShortcuts() {
  useMediaKeyboardShortcuts()
  return null
}

/** Headless: sincroniza .pwa-wco + variables --wco-* cuando la app corre instalada
 *  en escritorio con Window Controls Overlay (ver useWindowControlsOverlay.ts). */
function WindowControlsOverlaySync() {
  useWindowControlsOverlay()
  return null
}

/**
 * Pantalla de vuelta del login de Spotify. Spotify solo puede redirigir
 * a un path "real" (registrado tal cual en su dashboard), no a una ruta
 * con hash — así que esto vive fuera del HashRouter (ver el branch en
 * App() más abajo, antes de montarlo). Termina en una navegación de
 * página completa hacia /#/playlists, que sí vuelve a entrar al flujo
 * normal de la SPA.
 */
function SpotifyCallbackScreen() {
  useEffect(() => {
    let cancelled = false
    async function run() {
      try {
        await useAuthStore.getState().restoreSession()
        const email = useAuthStore.getState().currentUser?.email
        if (!email) throw new Error('No hay una sesión de XFY activa.')

        const tokenSet = await completeSpotifyLogin(new URLSearchParams(window.location.search))
        const profile = await fetchSpotifyProfile(tokenSet.accessToken)
        const spotifyAuth: SpotifyAuthPrefs = {
          accessToken: tokenSet.accessToken,
          refreshToken: tokenSet.refreshToken,
          expiresAt: tokenSet.expiresAt,
          profileId: profile.id,
          displayName: profile.displayName,
          avatarUrl: profile.avatarUrl,
        }
        await appDB.updateUser(email, { preferences: { spotifyAuth } })
        if (!cancelled) window.location.replace('/#/playlists?spotifyConnected=1')
      } catch (err) {
        console.warn('[spotify-callback]', err instanceof Error ? err.message : err)
        if (!cancelled) window.location.replace('/#/playlists?spotifyError=1')
      }
    }
    void run()
    return () => {
      cancelled = true
    }
  }, [])

  return <AppLoader />
}

function AppRoutes() {
  const location = useLocation()
  const navigate = useNavigate()
  const navigationType = useNavigationType() // 'PUSH' | 'POP' | 'REPLACE' — nos dice de qué lado tiene que entrar/salir la página
  const reduceMotion = useReducedMotion()
  // Forzado de remount tras "Reintentar": ErrorBoundary por sí solo puede
  // limpiar su propio hasError, pero la ruta que crasheó (ej. ArtistPage a
  // mitad de un fetch fallido) sigue montada con el mismo estado roto. Bumpear
  // esta key remonta el árbol de rutas entero — un reintento real, no solo
  // ocultar el mensaje de error.
  const [retryNonce, setRetryNonce] = useState(0)

  // direction: 1 = avanzar (PUSH), -1 = volver (POP). REPLACE (p. ej. el
  // fallback de smartGoBack cuando no hay stack propio) no tiene "sentido"
  // natural — se trata como avanzar, es la opción menos rara visualmente.
  const direction = navigationType === 'POP' ? -1 : 1

  // Contabiliza el stack propio de la SPA (ver backStack.ts): cada PUSH sube
  // el contador, cada POP lo baja. Es lo que le permite a smartGoBack (y por
  // lo tanto a todo BackButton + el swipe de borde) saber si un navigate(-1)
  // es seguro o si hay que caer a un fallback en vez de arriesgarse a salir
  // de la app. Sólo corre una vez por cambio de ruta real, no en cada render.
  const backStackDepth = useBackStackStore((s) => s.depth)
  const lastLocationKey = useRef(location.key)
  useEffect(() => {
    if (lastLocationKey.current === location.key) return
    lastLocationKey.current = location.key
    if (navigationType === 'PUSH') useBackStackStore.getState().markPush()
    else if (navigationType === 'POP') useBackStackStore.getState().markPop()
  }, [location.key, navigationType])

  // Gesto de volver arrastrando desde el borde izquierdo — ver
  // useEdgeSwipeBack.ts para el porqué (PWA standalone = sin gesto nativo
  // del sistema). Solo se arma si hay de verdad un "atrás" propio de la
  // SPA y no estamos en login (ahí no hay nada atrás salvo salir).
  const swipeEnabled = backStackDepth > 0 && location.pathname !== '/login'
  const { x: swipeX, progress: swipeProgress } = useEdgeSwipeBack({
    enabled: swipeEnabled,
    onCommit: () => smartGoBack(navigate, '/'),
  })

  return (
    // Antes había UN SOLO ErrorBoundary para toda la app (ver el de más abajo
    // en App()), envolviendo también AudioEngine/YouTubeEngine. Un error al
    // renderizar una sola página (p. ej. ArtistPage con datos inesperados) tiraba
    // TODA la interfaz a la pantalla de "Algo salió mal" — se perdía el
    // reproductor, la cola, todo — para un fallo que en realidad era de una
    // sola ruta. Este boundary, más interno y con resetKey=pathname, contiene el
    // daño a la página actual: el resto de la app (reproductor incluido) sigue
    // funcionando, y navegar a otra ruta (o tocar "Reintentar") se recupera solo.
    <ErrorBoundary
      resetKey={location.pathname}
      message="Esta página no pudo cargar. Puede ser un problema momentáneo de red o del servidor — probá de nuevo."
      onRetry={() => setRetryNonce((n) => n + 1)}
    >
      {/* Scrim del borde izquierdo: mientras se arrastra, simula la
          "pantalla anterior" asomándose detrás de la actual — mismo truco
          visual que iOS/Android sin tener que renderizar dos rutas reales
          en simultáneo (carísimo acá: cada página trae sus propios fetches
          y estado). swipeProgress va de 0 a 1 según qué tan cerca está el
          arrastre del umbral de "completar". */}
      {swipeEnabled && (
        <motion.div className="swipe-back-edge-scrim" style={{ width: swipeX, opacity: swipeProgress }} aria-hidden />
      )}
      <motion.div className="swipe-back-layer" style={swipeEnabled ? { x: swipeX } : undefined}>
        <Suspense fallback={<AppLoader />}>
          <AnimatePresence
            mode="wait"
            initial={false}
            custom={direction}
            onExitComplete={() => swipeX.jump(0)}
          >
            <motion.div
              key={`${location.pathname}:${retryNonce}`}
              custom={direction}
              variants={reduceMotion ? undefined : pageVariants}
              initial={reduceMotion ? false : 'initial'}
              animate={reduceMotion ? undefined : 'animate'}
              exit={reduceMotion ? undefined : 'exit'}
            >
              <Routes location={location}>
            <Route
              path="/login"
              element={
                <RedirectIfAuthed>
                  <AuthPage />
                </RedirectIfAuthed>
              }
            />
            <Route
              path="/"
              element={
                <RequireAuth>
                  <HomePage />
                </RequireAuth>
              }
            />
            <Route
              path="/artists"
              element={
                <RequireAuth>
                  <ArtistsPage />
                </RequireAuth>
              }
            />
            <Route
              path="/artist/:artistName"
              element={
                <RequireAuth>
                  <ArtistPage />
                </RequireAuth>
              }
            />
            <Route
              path="/album/:albumId"
              element={
                <RequireAuth>
                  <AlbumPage />
                </RequireAuth>
              }
            />
            <Route
              path="/player"
              element={
                <RequireAuth>
                  <PlayerPage />
                </RequireAuth>
              }
            />
            <Route
              path="/discover"
              element={
                <RequireAuth>
                  <DiscoverPage />
                </RequireAuth>
              }
            />
            <Route
              path="/playlists"
              element={
                <RequireAuth>
                  <PlaylistsPage />
                </RequireAuth>
              }
            />
            <Route
              path="/playlist/:playlistId"
              element={
                <RequireAuth>
                  <PlaylistDetailPage />
                </RequireAuth>
              }
            />
            <Route
              path="/settings"
              element={
                <RequireAuth>
                  <SettingsPage />
                </RequireAuth>
              }
            />
            <Route
              path="/wrapped"
              element={
                <RequireAuth>
                  <WrappedPage />
                </RequireAuth>
              }
            />
            <Route
              path="/blend"
              element={
                <RequireAuth>
                  <BlendPage />
                </RequireAuth>
              }
            />
              <Route path="*" element={<Navigate to="/" replace />} />
              </Routes>
            </motion.div>
          </AnimatePresence>
        </Suspense>
      </motion.div>
    </ErrorBoundary>
  )
}

export { SpotifyCallbackScreen }

export default function App() {
  const restoreSession = useAuthStore((s) => s.restoreSession)
  const status = useAuthStore((s) => s.status)
  const currentUser = useAuthStore((s) => s.currentUser)
  // Visibilidad de la tarjeta de instalación PWA: comparte la lane
  // superior-centrada con los toasts, así que el Toaster baja su offset
  // mientras la tarjeta está en pantalla (ver PwaInstallPrompt).
  const [installVisible, setInstallVisible] = useState(false)
  // Igual que installVisible: si el aviso de notificaciones está en
  // pantalla, el Toaster (y la propia tarjeta de notificaciones, ver
  // stacked en JSX abajo) se corren para no taparse con la de instalar.
  const [notifVisible, setNotifVisible] = useState(false)

  useEffect(() => {
    restoreSession()
  }, [restoreSession])

  // Contraparte del 401 que dispara apiClient.ts cuando el token deja de
  // ser válido — más común: revocaste ESTA sesión desde el panel de
  // Dispositivos en otro aparato. Sin este listener, el evento se perdía
  // en el aire y la app quedaba "logueada" en pantalla con un token
  // muerto hasta que alguien recargaba a mano.
  useEffect(() => {
    function onSessionExpired() {
      if (!useAuthStore.getState().currentUser) return
      useAuthStore.getState().handleSessionExpired()
      toast.info('Tu sesión expiró, iniciá sesión de nuevo.')
    }
    window.addEventListener('xfy:session-expired', onSessionExpired)
    return () => window.removeEventListener('xfy:session-expired', onSessionExpired)
  }, [])

  // Integraciones de OS de la PWA instalada: share_target (compartir un
  // link de YouTube → suena acá) y file_handlers (abrir un audio con XFY).
  // initFileHandlers tiene que correr temprano — launchQueue solo entrega
  // los archivos al primer setConsumer. consumeSharedTarget procesa la
  // query del share y se autolimpia.
  useEffect(() => {
    try {
      initFileHandlers()
    } catch {
      /* noop */
    }
    void consumeSharedTarget().catch(() => {})
  }, [])

  // Modo del tema activo (light/dark) para las piezas fuera de los tokens
  // — hoy, los toasts de Sonner, que venían hardcodeados en dark y quedaban
  // como un panel oscuro flotando sobre los temas claros. applyTheme
  // publica el modo por evento + data-theme-mode en <html>.
  const [themeMode, setThemeMode] = useState<'dark' | 'light'>('dark')
  useEffect(() => {
    // applyTheme despacha 'xfy:themechange' en CADA aplicación (boot
    // incluido), así que este listener solo necesita suscribirse — el
    // estado inicial llega solo, no hace falta leer el DOM acá.
    const onThemeChange = (e: Event) => {
      const mode = (e as CustomEvent<{ mode?: string }>).detail?.mode
      setThemeMode(mode === 'light' ? 'light' : 'dark')
    }
    window.addEventListener('xfy:themechange', onThemeChange)
    return () => window.removeEventListener('xfy:themechange', onThemeChange)
  }, [])

  // Carga (y mantiene sincronizados) los temas personalizados del usuario:
  // ver el comentario grande en customThemesStore.ts — este store es la
  // pieza que faltaba para que applyTheme() pueda resolver un tema custom
  // acá, no solo dentro de SettingsPage.
  const customThemes = useCustomThemesStore((s) => s.themes)
  const loadCustomThemes = useCustomThemesStore((s) => s.load)
  useEffect(() => {
    void loadCustomThemes(currentUser?.email)
  }, [currentUser?.email, loadCustomThemes])

  useEffect(() => {
    applyTheme(currentUser?.preferences?.theme, customThemes)
  }, [currentUser?.preferences?.theme, customThemes])

  // Claridad del vidrio: mismo patrón que el tema (aplica al boot y cada
  // vez que cambia la preferencia guardada), pero es un eje independiente
  // del color — ver glassClarity.ts.
  useEffect(() => {
    const clarity = currentUser?.preferences?.glassClarity
    applyGlassClarity(isValidGlassClarity(clarity) ? clarity : 'balanced')
  }, [currentUser?.preferences?.glassClarity])

  useEffect(() => {
    if (currentUser?.email) usePlaylistsStore.getState().loadPlaylists(currentUser.email)
  }, [currentUser?.email])

  useEffect(() => {
    useSpotifyConnectStore.getState().load(currentUser?.email, currentUser?.preferences?.spotifyAuth)
  }, [currentUser?.email, currentUser?.preferences?.spotifyAuth])

  useEffect(() => {
    const flush = () => usePlayerStore.getState()._flushMetrics()
    window.addEventListener('beforeunload', flush)
    window.addEventListener('pagehide', flush)
    return () => {
      window.removeEventListener('beforeunload', flush)
      window.removeEventListener('pagehide', flush)
    }
  }, [])

  // Smart Cache sweeper (estilo Smart Downloads de YT Music): repone en
  // caché lo que el usuario claramente escucha. Corre al iniciar sesión,
  // cada hora y al volver la pestaña/PWA a primer plano; smartCache lo
  // throttlea internamente (mínimo 30 min entre sweeps, tope de descargas
  // por sweep) así estos disparadores no saturan datos móviles.
  //
  // Las canciones de las playlists guardadas del usuario entran como
  // candidatas más (además de top-songs y recién escuchadas): así el
  // sweep no solo cachea lo que YA sonó, sino lo que el usuario armó a
  // propósito para escuchar después, esté sonando o no.
  useEffect(() => {
    if (!currentUser?.email) return undefined

    const run = (force = false) => {
      const libraryPlaylistSongs = usePlaylistsStore
        .getState()
        .playlists.flatMap((p) => p.songs || [])
      sweepHeavyRotation({
        recentlyPlayed: usePlayerStore.getState().getRecentlyPlayed(),
        libraryPlaylistSongs,
        force,
      })
      // Precachea (o revalida por TTL) las listas de catálogo del Home,
      // para que la próxima vez que el usuario entre ya estén listas.
      warmHomeCatalogCache(force)
    }

    run(true)
    // Poda por edad de lo cacheado (audio/portadas): a diferencia del
    // desalojo por cupo (que solo actúa si el storage se llena), esta
    // corre siempre, así que lo que hace mucho no se reproduce se borra
    // solo aunque nunca se llegue al límite de espacio.
    pruneAgedAssets().catch(() => {})
    const interval = setInterval(() => run(), 60 * 60 * 1000)
    const pruneInterval = setInterval(() => pruneAgedAssets().catch(() => {}), 24 * 60 * 60 * 1000)
    const onVisible = () => {
      if (document.visibilityState === 'visible') run()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      clearInterval(pruneInterval)
      clearInterval(interval)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [currentUser?.email])

  return (
    <HashRouter>
      <ErrorBoundary>
        {/* Franja arrastrable del titlebar nativo cuando la PWA corre instalada
            en escritorio con Window Controls Overlay — invisible/display:none
            en cualquier otro modo (pestaña normal, móvil). Ver App.css. */}
        <div className="app-titlebar-drag" aria-hidden="true" />
        <AudioEngine />
        <YouTubeEngine />

        <MediaSessionSync />
        <PwaRegistration />
        <Toaster
          theme={themeMode}
          position="top-center"
          icons={{
            success: <CheckCircle2 strokeWidth={2.4} />,
            error: <XCircle strokeWidth={2.4} />,
            warning: <AlertTriangle strokeWidth={2.4} />,
            info: <Info strokeWidth={2.4} />,
            loading: <Loader2 strokeWidth={2.4} className="app-toast-spin" />,
          }}
          offset={{
            top:
              installVisible || notifVisible
                ? `calc(env(safe-area-inset-top) + ${installVisible && notifVisible ? '10.75rem' : '6rem'})`
                : 'calc(env(safe-area-inset-top) + 1rem)',
          }}
          mobileOffset={{ top: 'calc(env(safe-area-inset-top) + 1rem)' }}
        />
        <PwaInstallPrompt onVisibilityChange={setInstallVisible} />
        {/* stacked: si el aviso de instalar ya está arriba, esta tarjeta se
            corre debajo en vez de superponerse — comparten la misma lane. */}
        <NotificationPermissionPrompt stacked={installVisible} onVisibilityChange={setNotifVisible} />
        {/* MobileTabBar y MiniPlayerBar YA NO dependen de `status`: antes,
            mientras status era 'loading'/'idle', ni siquiera se montaban —
            así que CADA arranque (y cada reload que dispara una
            actualización silenciosa, ver PwaRegistration) los hacía
            aparecer de cero: remontar, medir su ancho desde cero, y recién
            ahí acomodarse en su posición final. Eso es el "brinco"/"se
            ve más abajo" que se nota justo después de recargar. Ahora se
            montan siempre, desde el primer render — su propio `show`
            interno (currentUser + ruta) ya los mantenía ocultos por CSS en
            login/reproductor (ver MobileTabBar.jsx), así que solo hacía
            falta dejar de taparlos con este condicional. Mientras carga,
            AppRoutes no pinta nada (RequireAuth/RedirectIfAuthed devuelven
            null hasta status='ready') y la barra sigue invisible por su
            propio `show`, así que AppLoader se sigue viendo exactamente
            igual que antes — la diferencia es que ya no hay nada que
            remontar de golpe cuando termina de cargar: la barra ya estaba
            ahí, ya medida, solo empieza a mostrarse con su propia
            transición (opacity/transform, ver MobileTabBar.css). */}
        <GlobalMediaShortcuts />
        <WindowControlsOverlaySync />
        <AppRoutes />
        <MiniPlayerBar />
        <MobileTabBar />
        {/* AnimatePresence acá para que el `exit` de AppLoader corra: sin esto
            React lo desmonta en el frame siguiente a que `status` deja de ser
            'loading'/'idle' y el corte se siente seco contra el fondo oscuro
            de la app ya montada debajo. */}
        <AnimatePresence>
          {(status === 'loading' || status === 'idle') && <AppLoader key="app-loader" />}
        </AnimatePresence>
      </ErrorBoundary>
    </HashRouter>
  )
}
