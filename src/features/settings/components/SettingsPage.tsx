import { useEffect, useRef, useState } from 'react'
import type { CSSProperties, FormEvent } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import {
  ArrowLeft,
  Trash2,
  HardDrive,
  Sparkles,
  Radio,
  Check,
  LogOut,
  Image as ImageIcon,
  Mic2,
  Disc3,
  UserRound,
  Plus,
  X,
  EyeOff,
  WifiOff,
  Download,
  Bell,
  Camera,
  Loader2,
  SkipForward,
  Music4,
  Puzzle,
  ChevronRight,
  Search,
  ShieldCheck,
} from 'lucide-react'
import { toast } from 'sonner'
import { useAuthStore } from '@features/auth'
import { usePlayerStore } from '@features/player'
import useMediaQuery from '@shared/lib/useMediaQuery'
import { appDB } from '@shared/lib/db'
import type { CustomThemeRecord } from '@shared/lib/db'
import type { LucideIcon } from 'lucide-react'
import { THEMES, applyTheme, buildCustomTheme, isValidHexColor } from '@features/settings/lib/themes'
import { GLASS_CLARITY_OPTIONS, applyGlassClarity, isValidGlassClarity } from '@features/settings/lib/glassClarity'
import { useCustomThemesStore } from '@features/settings/lib/customThemesStore'
import SecurityPanel from '@features/settings/components/SecurityPanel'
import {
  getAssetCacheStats,
  getMetadataCacheStats,
  clearAssetCache,
  clearMetadataCache,
  formatBytes,
} from '@shared/lib/cacheManager'
import { clearMetrics, isPrivateSessionEnabled, setPrivateSessionEnabled } from '@shared/lib/metrics'
import { isSponsorBlockEnabled, setSponsorBlockEnabled } from '@services/api/sponsorblock'
import {
  isScrobbleEnabled,
  setScrobbleEnabled,
  getScrobbleCredentials,
  setScrobbleCredentials,
} from '@shared/lib/scrobble'
import { getAllPlugins, isPluginEnabled, setPluginEnabled } from '@services/plugins'
import { isDataSaverEnabled, setDataSaverEnabled } from '@features/player/lib/smartCache'
import { subscribeDownloadProgress } from '@features/player/lib/downloadQueue'
import type { DownloadProgress } from '@features/player/lib/downloadQueue'
import {
  isReleaseWatchEnabled,
  setReleaseWatchEnabled,
  sweepReleases,
} from '@shared/lib/releaseWatch'
import {
  getNotificationPermission,
  requestNotificationPermission,
} from '@shared/lib/appNotifications'
import Sidebar from '@shared/components/Sidebar'
import BackButton from '@shared/components/BackButton'
import './SettingsPage.css'

/** Ícono representativo por tipo de metadato cacheado, para que la lista de caché
 *  se lea de un vistazo en vez de ser puro texto en fila. */
const META_ICONS: Record<string, LucideIcon> = {
  xfy_itunes_artwork_cache_v1: ImageIcon,
  xfy_audiodb_cache_v2: UserRound,
  xfy_lrclib_cache_v1: Mic2,
  xfy_musicbrainz_cache_v2: Disc3,
}

/**
 * Fila "Nuevos lanzamientos": notificaciones del sistema cuando un artista
 * muy escuchado saca álbum/canción nueva (ver releaseWatch.ts). Activarlo
 * desde acá es un gesto de usuario legítimo para pedir el permiso si
 * todavía está pendiente; si el navegador lo tiene bloqueado, se explica
 * el camino manual en vez de insistir con prompts que no van a salir.
 */
function ReleaseWatchRow() {
  const [enabled, setEnabled] = useState(isReleaseWatchEnabled)
  const [permission, setPermission] = useState(getNotificationPermission)

  const handleToggle = async () => {
    const turningOn = !enabled
    if (!turningOn) {
      setReleaseWatchEnabled(false)
      setEnabled(false)
      return
    }

    if (getNotificationPermission() === 'default') {
      const result = await requestNotificationPermission()
      setPermission(result)
      if (result !== 'granted') {
        toast.error('No se pudo activar el permiso', {
          description:
            result === 'denied'
              ? 'Las notificaciones de XFY están bloqueadas — activalas desde el candado/ⓘ junto a la dirección del sitio.'
              : 'Intentá de nuevo en unos segundos.',
        })
        return
      }
    } else if (getNotificationPermission() !== 'granted') {
      return // denied/unsupported: el toggle no hace nada visible que confunda
    }

    setReleaseWatchEnabled(true)
    setEnabled(true)
    toast.success('Avisos de lanzamientos activados')
    // Primera barrida inmediata: fija la línea base de los artistas (sin
    // notificar catálogo viejo) para que los próximos avisos sean reales.
    void sweepReleases({ force: true }).catch(() => {})
  }

  const blocked = permission === 'denied' || permission === 'unsupported'

  return (
    <div className="settings-row-item">
      <div className="settings-row-icon">
        <Bell size={16} />
      </div>
      <div className="settings-row-text">
        <span className="settings-row-title">Nuevos lanzamientos</span>
        <span className="settings-row-desc">
          {blocked
            ? 'Permiso de notificaciones bloqueado — activalo desde la configuración del sitio en tu navegador.'
            : 'Te avisa cuando uno de tus artistas más escuchados saca álbum o canción nueva.'}
        </span>
      </div>
      <button
        className={`settings-toggle ${enabled && !blocked ? 'on' : ''}`}
        role="switch"
        aria-checked={enabled && !blocked}
        onClick={() => void handleToggle()}
      >
        <span className="settings-toggle-knob" />
      </button>
    </div>
  )
}

/**
 * Categorías al estilo "Ajustes de usuario" de Discord: un riel de
 * navegación agrupado (en vez de una sola página larga con scroll
 * infinito) donde cada categoría es su propio panel. En mobile el riel
 * se vuelve la pantalla inicial y cada categoría abre a pantalla
 * completa con un botón de volver, igual que la versión móvil de Discord.
 */
type CategoryId = 'account' | 'security' | 'appearance' | 'playback' | 'sources' | 'storage'

interface CategoryDef {
  id: CategoryId
  label: string
  desc: string
  icon: LucideIcon
  group: string
}

const CATEGORIES: CategoryDef[] = [
  { id: 'account', label: 'Mi cuenta', desc: 'Tu perfil y tu sesión', icon: UserRound, group: 'Cuenta' },
  { id: 'security', label: 'Seguridad', desc: 'Passkeys, verificación en dos pasos y sesiones activas', icon: ShieldCheck, group: 'Cuenta' },
  { id: 'appearance', label: 'Apariencia', desc: 'Colores y tema de XFY', icon: Sparkles, group: 'Preferencias' },
  { id: 'playback', label: 'Reproducción', desc: 'Cómo suena y se comporta la música', icon: Disc3, group: 'Preferencias' },
  { id: 'sources', label: 'Fuentes de música', desc: 'De dónde viene tu catálogo', icon: Puzzle, group: 'Preferencias' },
  { id: 'storage', label: 'Almacenamiento', desc: 'Lo que XFY guarda en tu dispositivo', icon: HardDrive, group: 'Datos' },
]

/** Color fijo por categoría, al estilo de los íconos de Ajustes de iOS/macOS:
 *  cada sección tiene una identidad propia (independiente del acento de tema
 *  elegido por el usuario) para que el riel se lea de un vistazo por color,
 *  igual que Notificaciones siempre es roja o Wi-Fi siempre es azul. Se usa
 *  como tinte suave en reposo; la selección real sigue marcándose con el
 *  acento del tema (pill + color de texto), así ambos lenguajes conviven sin
 *  pisarse. */
const CATEGORY_TINT: Record<CategoryId, string> = {
  account: '#0a84ff',
  security: '#ff453a',
  appearance: '#bf5af2',
  playback: '#30d158',
  sources: '#ff9f0a',
  storage: '#8e8e93',
}

export default function SettingsPage() {
  // >=900px: riel + panel lado a lado, siempre los dos visibles (igual que
  // el desktop de Discord). Por debajo: o el riel (lista de categorías) o
  // el panel a pantalla completa, nunca los dos — activeCategory manda cuál.
  const isDesktop = useMediaQuery('(min-width: 900px)')
  const [activeCategory, setActiveCategory] = useState<CategoryId>('account')
  const [mobileShowingPanel, setMobileShowingPanel] = useState(false)
  // Buscador del riel (patrón "Search settings" de Spotify): filtra las
  // categorías por nombre en vivo, sin abrir nada — es una lupa sobre la
  // lista existente, no una segunda pantalla.
  const [railSearch, setRailSearch] = useState('')
  const railQuery = railSearch.trim().toLowerCase()
  const visibleCategories = railQuery
    ? CATEGORIES.filter((c) => c.label.toLowerCase().includes(railQuery))
    : CATEGORIES
  const { currentUser, logout } = useAuthStore()
  const avatarInputRef = useRef<HTMLInputElement>(null)
  const [avatarUploading, setAvatarUploading] = useState(false)
  const autoplayEnabled = usePlayerStore((s) => s.autoplayEnabled)
  const setAutoplayEnabled = usePlayerStore((s) => s.setAutoplayEnabled)
  const [nickname, setNickname] = useState(currentUser?.nickname || '')
  const [assetStats, setAssetStats] = useState(() => getAssetCacheStats())
  const [metaStats, setMetaStats] = useState(() => getMetadataCacheStats())
  const [refreshTick, setRefreshTick] = useState(0)
  const prevTickRef = useRef(refreshTick)

  // Store compartido (no useState local): así App.tsx ve exactamente los
  // mismos temas custom que esta página, y un tema recién creado no se
  // "auto-revierte" al aplicarse desde acá y luego reaplicarse desde el
  // efecto global de App.tsx con una lista distinta. Ver customThemesStore.ts.
  const customThemes = useCustomThemesStore((s) => s.themes)
  const upsertCustomTheme = useCustomThemesStore((s) => s.upsert)
  const removeCustomTheme = useCustomThemesStore((s) => s.remove)
  const [showThemeCreator, setShowThemeCreator] = useState(false)
  const [creatorName, setCreatorName] = useState('')
  const [creatorBg, setCreatorBg] = useState('#0c0a1d')
  const [creatorBgElevated, setCreatorBgElevated] = useState('#1c183c')
  const [creatorAccent, setCreatorAccent] = useState('#8b5cf6')
  const [creatorInk, setCreatorInk] = useState('#f5f5f7')

  const [privateSession, setPrivateSessionState] = useState(() => isPrivateSessionEnabled())
  const [dataSaver, setDataSaverState] = useState(() => isDataSaverEnabled())
  const [sponsorBlock, setSponsorBlockState] = useState(() => isSponsorBlockEnabled())
  const [scrobbleEnabled, setScrobbleEnabledState] = useState(() => isScrobbleEnabled())
  const [scrobbleCreds, setScrobbleCredsState] = useState(() => getScrobbleCredentials())
  const [showScrobbleSetup, setShowScrobbleSetup] = useState(false)
  // Snapshot de qué fuentes están habilitadas — se recalcula al montar
  // porque isPluginEnabled lee de localStorage, no de un store reactivo.
  const sourcePlugins = getAllPlugins()
  const [pluginEnabledMap, setPluginEnabledMap] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(sourcePlugins.map((p) => [p.id, isPluginEnabled(p.id)])),
  )

  // Descargas de assets en curso (audio/portadas entrando al caché del
  // dispositivo) — en vivo vía la cola global; se muestra solo cuando hay
  // actividad para no sumar ruido permanente a la pantalla.
  const [activeDownloads, setActiveDownloads] = useState<DownloadProgress[]>([])
  useEffect(() => subscribeDownloadProgress(setActiveDownloads), [])

  useEffect(() => {
    if (prevTickRef.current !== refreshTick) {
      setAssetStats(getAssetCacheStats())
      setMetaStats(getMetadataCacheStats())
      prevTickRef.current = refreshTick
    }
  }, [refreshTick])

  const currentTheme = currentUser?.preferences?.theme || 'default-dark'
  const activeThemeMeta =
    THEMES.find((t) => t.id === currentTheme) || customThemes.find((t) => t.id === currentTheme) || THEMES[0]

  const persistTheme = async (themeId: string) => {
    if (!currentUser) return
    const updatedPreferences = { ...currentUser.preferences, theme: themeId }
    await appDB.updateUser(currentUser.email, { preferences: updatedPreferences })
    useAuthStore.setState({ currentUser: { ...currentUser, preferences: updatedPreferences } })
  }

  const currentGlassClarity = isValidGlassClarity(currentUser?.preferences?.glassClarity)
    ? currentUser.preferences.glassClarity
    : 'balanced'

  const handleGlassClarityChange = async (id: typeof currentGlassClarity) => {
    if (!currentUser) return
    applyGlassClarity(id)
    const updatedPreferences = { ...currentUser.preferences, glassClarity: id }
    await appDB.updateUser(currentUser.email, { preferences: updatedPreferences })
    useAuthStore.setState({ currentUser: { ...currentUser, preferences: updatedPreferences } })
  }

  const handleThemeChange = async (themeId: string) => {
    if (!currentUser) return
    // animate: el swap va dentro de startViewTransition (crossfade suave
    // de toda la app). En boot NO se anima — ahí tiene que pintar seco.
    applyTheme(themeId, customThemes, { animate: true })
    await persistTheme(themeId)
  }

  const handleApplyCustomTheme = async (theme: CustomThemeRecord) => {
    if (!currentUser) return
    applyTheme(theme, customThemes, { animate: true })
    await persistTheme(theme.id)
  }

  const handleCreateCustomTheme = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    if (!currentUser) return
    const name = creatorName.trim()
    if (!name) {
      toast.error('Ingresá un nombre para el tema')
      return
    }
    if (![creatorBg, creatorBgElevated, creatorAccent, creatorInk].every(isValidHexColor)) {
      toast.error('Uno o más colores no son válidos')
      return
    }
    const theme = {
      ...buildCustomTheme({
        name,
        bg: creatorBg,
        bgElevated: creatorBgElevated,
        accent: creatorAccent,
        ink: creatorInk,
      }),
      userEmail: currentUser.email,
      createdAt: new Date().toISOString(),
      // buildCustomTheme entrega las 17 claves tipadas (ThemeColors); el
      // registro en IndexedDB las guarda como Record<string,string> plano.
    } as CustomThemeRecord

    const ok = await appDB.saveCustomTheme(theme)
    if (!ok) {
      toast.error('No se pudo guardar el tema')
      return
    }
    upsertCustomTheme(theme)
    await handleApplyCustomTheme(theme)
    setCreatorName('')
    setShowThemeCreator(false)
    toast.success(`Tema "${name}" creado y aplicado`)
  }

  const handleDeleteCustomTheme = async (theme: CustomThemeRecord) => {
    if (!currentUser) return
    const ok = await appDB.deleteCustomTheme(theme.id)
    if (!ok) {
      toast.error('No se pudo eliminar el tema')
      return
    }
    removeCustomTheme(theme.id)
    if (currentTheme === theme.id) {
      applyTheme('default-dark')
      await persistTheme('default-dark')
    }
    toast.success(`Tema "${theme.name}" eliminado`)
  }

  const handleTogglePrivateSession = () => {
    const next = !privateSession
    setPrivateSessionState(next)
    setPrivateSessionEnabled(next)
  }

  const handleToggleDataSaver = () => {
    const next = !dataSaver
    setDataSaverState(next)
    setDataSaverEnabled(next)
  }

  const handleToggleSponsorBlock = () => {
    const next = !sponsorBlock
    setSponsorBlockState(next)
    setSponsorBlockEnabled(next)
  }

  const handleToggleScrobble = () => {
    const next = !scrobbleEnabled
    setScrobbleEnabledState(next)
    setScrobbleEnabled(next)
    if (next) setShowScrobbleSetup(true)
  }

  const handleSaveScrobbleCreds = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    setScrobbleCredentials(scrobbleCreds)
    toast.success('Credenciales de scrobbling guardadas')
  }

  const handleTogglePlugin = (id: string) => {
    const next = !pluginEnabledMap[id]
    setPluginEnabled(id, next)
    setPluginEnabledMap((prev) => ({ ...prev, [id]: next }))
  }

  const handleSaveNickname = async () => {
    if (!currentUser || !nickname.trim() || nickname === currentUser.nickname) return
    try {
      await appDB.updateUser(currentUser.email, { nickname: nickname.trim() })
      useAuthStore.setState({ currentUser: { ...currentUser, nickname: nickname.trim() } })
      toast.success('Nombre actualizado')
    } catch {
      toast.error('No se pudo completar la acción.')
    }
  }

  // Reduce cualquier foto (aunque venga de una cámara de 12MP) a un cuadrado
  // chico antes de guardarla como data URL: sin esto, IndexedDB terminaría
  // con avatares de varios MB cada uno. object-fit "cover" manual: recorta
  // al centro del lado más corto para no deformar la foto.
  async function downscaleToSquareDataUrl(file: File, size = 320): Promise<string> {
    const bitmap = await createImageBitmap(file)
    const side = Math.min(bitmap.width, bitmap.height)
    const sx = (bitmap.width - side) / 2
    const sy = (bitmap.height - side) / 2
    const canvas = document.createElement('canvas')
    canvas.width = size
    canvas.height = size
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('canvas 2d context unavailable')
    ctx.drawImage(bitmap, sx, sy, side, side, 0, 0, size, size)
    return canvas.toDataURL('image/jpeg', 0.88)
  }

  const handleAvatarPick = () => avatarInputRef.current?.click()

  const handleAvatarChange = async (e: FormEvent<HTMLInputElement> & { target: HTMLInputElement }) => {
    const file = e.target.files?.[0]
    e.target.value = '' // permite re-elegir el mismo archivo después
    if (!file || !currentUser) return
    if (!file.type.startsWith('image/')) {
      toast.error('Elegí un archivo de imagen.')
      return
    }
    setAvatarUploading(true)
    try {
      const avatarUrl = await downscaleToSquareDataUrl(file)
      await appDB.updateUser(currentUser.email, { avatarUrl })
      useAuthStore.setState({ currentUser: { ...currentUser, avatarUrl } })
      toast.success('Foto de perfil actualizada')
    } catch {
      toast.error('No se pudo actualizar la foto de perfil.')
    } finally {
      setAvatarUploading(false)
    }
  }

  const handleClearAudioCache = async () => {
    try {
      await clearAssetCache()
      setRefreshTick((t) => t + 1)
      toast.success('Caché de audio vaciada')
    } catch {
      toast.error('No se pudo completar la acción.')
    }
  }

  const handleClearMetadataCache = () => {
    clearMetadataCache()
    setRefreshTick((t) => t + 1)
    toast.success('Caché de metadatos vaciada')
  }

  const handleClearListeningHistory = () => {
    clearMetrics()
    toast.success('Historial de escucha borrado')
  }

  const audioPct = Math.min(100, Math.round((assetStats.totalBytes / assetStats.quotaBytes) * 100))
  const metaTotalBytes = metaStats.reduce((sum, s) => sum + s.bytes, 0)
  const metaTotalCount = metaStats.reduce((sum, s) => sum + s.count, 0)

  return (
    <div className="settings-page settings-page--discord">
      <Sidebar />

      <BackButton />

      <header className="settings-header">
        <p className="home-section-kicker">Tu cuenta</p>
        <h1 className="discover-title">Configuración</h1>
      </header>

      {/* --- Riel de categorías + panel, al estilo Ajustes de Discord: en
          desktop los dos conviven lado a lado; en mobile es uno u otro
          (lista de categorías, o la categoría abierta a pantalla completa
          con su propio volver) según mobileShowingPanel. --- */}
      {/* AnimatePresence envuelve riel + panel: en mobile solo uno de los dos
          existe en un momento dado, así que su entrada/salida se anima como
          un "push" de navegación (deslizar + fade) en vez del corte seco que
          había antes. En desktop ambos persisten montados siempre, así que
          la animación de entrada corre una sola vez al cargar y listo. */}
      <div className="settings-shell">
        <AnimatePresence mode="wait" initial={false}>
        {(isDesktop || !mobileShowingPanel) && (
          <motion.nav
            key="rail"
            className="settings-rail"
            aria-label="Categorías de ajustes"
            initial={isDesktop ? false : { opacity: 0, x: -18 }}
            animate={{ opacity: 1, x: 0 }}
            exit={isDesktop ? undefined : { opacity: 0, x: -18 }}
            transition={{ duration: 0.22, ease: [0.23, 1, 0.32, 1] }}
          >
            <label className="settings-rail-search">
              <Search size={15} className="settings-rail-search-icon" />
              <input
                type="text"
                value={railSearch}
                onChange={(e) => setRailSearch(e.target.value)}
                placeholder="Buscar en ajustes"
                aria-label="Buscar en ajustes"
              />
              {railSearch && (
                <button
                  type="button"
                  className="settings-rail-search-clear"
                  onClick={() => setRailSearch('')}
                  aria-label="Borrar búsqueda"
                >
                  <X size={13} />
                </button>
              )}
            </label>

            {visibleCategories.length === 0 && (
              <p className="settings-rail-empty">Sin resultados para "{railSearch}"</p>
            )}

            {(['Cuenta', 'Preferencias', 'Datos'] as const).map((group) => {
              const items = visibleCategories.filter((c) => c.group === group)
              if (items.length === 0) return null
              return (
                <div className="settings-rail-group" key={group}>
                  <p className="settings-rail-group-label">{group}</p>
                  {items.map((cat) => {
                    const Icon = cat.icon
                    const active = isDesktop && activeCategory === cat.id
                    return (
                      <button
                        key={cat.id}
                        type="button"
                        className={`settings-rail-item ${active ? 'active' : ''}`}
                        style={{ '--row-tint': CATEGORY_TINT[cat.id] } as CSSProperties}
                        onClick={() => {
                          setActiveCategory(cat.id)
                          setMobileShowingPanel(true)
                        }}
                      >
                        {/* Fondo activo compartido entre botones vía layoutId: en vez de
                            que el resaltado "salte" de una fila a otra, motion anima la
                            MISMA pieza deslizándose de la posición vieja a la nueva —
                            el efecto de "pastilla" que se desliza del riel de Ajustes
                            de Discord, en vez de un fondo estático por fila. */}
                        {active && (
                          <motion.span
                            layoutId="settings-rail-active-pill"
                            className="settings-rail-item-pill"
                            transition={{ type: 'spring', stiffness: 500, damping: 40 }}
                          />
                        )}
                        <span className="settings-rail-item-icon-wrap">
                          <Icon size={16} className="settings-rail-item-icon" />
                        </span>
                        <span className="settings-rail-item-text">
                          <span className="settings-rail-item-label">{cat.label}</span>
                          <span className="settings-rail-item-desc">{cat.desc}</span>
                        </span>
                        <ChevronRight size={15} className="settings-rail-item-chevron" />
                      </button>
                    )
                  })}
                </div>
              )
            })}
            <button className="settings-rail-logout" type="button" onClick={logout}>
              <LogOut size={16} />
              Cerrar sesión
            </button>
          </motion.nav>
        )}

        {(isDesktop || mobileShowingPanel) && (
          <motion.div
            key="content"
            className="settings-content"
            initial={isDesktop ? false : { opacity: 0, x: 18 }}
            animate={{ opacity: 1, x: 0 }}
            exit={isDesktop ? undefined : { opacity: 0, x: 18 }}
            transition={{ duration: 0.22, ease: [0.23, 1, 0.32, 1] }}
          >
            {!isDesktop && (
              <button
                type="button"
                className="settings-content-back"
                onClick={() => setMobileShowingPanel(false)}
              >
                <ArrowLeft size={16} />
                Categorías
              </button>
            )}
            {(() => {
              const active = CATEGORIES.find((c) => c.id === activeCategory)
              if (!active) return null
              const ActiveIcon = active.icon
              return (
                <div
                  className="settings-content-header"
                  style={{ '--row-tint': CATEGORY_TINT[active.id] } as CSSProperties}
                >
                  <span className="settings-content-header-icon">
                    <ActiveIcon size={18} />
                  </span>
                  <div>
                    <h2 className="settings-content-title">{active.label}</h2>
                    <p className="settings-content-desc">{active.desc}</p>
                  </div>
                </div>
              )
            })()}

            {/* Crossfade + leve slide vertical al cambiar de categoría — evita el
                "salto" seco que había antes al intercambiar secciones enteras del
                DOM sin transición alguna. mode="wait" para que la saliente
                termine de irse antes de que entre la próxima (sin solaparse). */}
            <AnimatePresence mode="wait">
              <motion.div
                key={activeCategory}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -6 }}
                transition={{ duration: 0.2, ease: [0.23, 1, 0.32, 1] }}
                className="settings-panel-transition"
              >
            {activeCategory === 'account' && (
              <>
                {/* --- Hero de perfil: el anillo del avatar toma el acento del
                    tema activo, así perfil y apariencia quedan conectados a
                    simple vista en vez de ser dos cajas sin relación. --- */}
                <section className="settings-hero">
                  <button
                    type="button"
                    className="settings-hero-avatar-ring settings-hero-avatar-ring--editable"
                    onClick={handleAvatarPick}
                    aria-label="Cambiar foto de perfil"
                  >
                    <img
                      src={currentUser?.avatarUrl || `https://placehold.co/160x160/1a1a20/ffffff?text=${(nickname || 'U').charAt(0).toUpperCase()}`}
                      alt=""
                      className="settings-hero-avatar"
                    />
                    <span className="settings-hero-avatar-edit" aria-hidden="true">
                      {avatarUploading ? <Loader2 size={16} className="settings-hero-avatar-spinner" /> : <Camera size={16} />}
                    </span>
                    <input
                      ref={avatarInputRef}
                      type="file"
                      accept="image/*"
                      className="settings-hero-avatar-input"
                      onChange={handleAvatarChange}
                      aria-hidden="true"
                      tabIndex={-1}
                    />
                  </button>
                  <div className="settings-hero-fields">
                    <input
                      className="settings-hero-name"
                      value={nickname}
                      onChange={(e) => setNickname(e.target.value)}
                      onBlur={handleSaveNickname}
                      aria-label="Nombre"
                      placeholder="Tu nombre"
                    />
                    <p className="settings-hero-email">{currentUser?.email}</p>
                  </div>
                </section>
                <button className="settings-logout settings-logout--mobile" onClick={logout}>
                  <LogOut size={16} />
                  Cerrar sesión
                </button>
              </>
            )}

            {activeCategory === 'security' && <SecurityPanel />}

            {activeCategory === 'appearance' && (
              <section className="settings-group" style={{ '--row-tint': CATEGORY_TINT[activeCategory] } as CSSProperties}>
                <div className="settings-row-item settings-row-item--theme">
                  <div className="settings-row-text">
                    <span className="settings-row-title">Tema</span>
                    <span className="settings-row-desc">{activeThemeMeta?.name} · define el fondo, el vidrio y el acento de toda la app</span>
                  </div>
                </div>
                <div className="settings-theme-picker">
                  {THEMES.map((theme) => {
                    const active = currentTheme === theme.id
                    return (
                      <button
                        key={theme.id}
                        type="button"
                        className={`settings-swatch ${active ? 'active' : ''}`}
                        style={
                          {
                            '--swatch': theme.swatchAccent,
                            '--swatch-bg': theme.swatchBg,
                            '--swatch-check': theme.swatchCheck,
                          } as CSSProperties
                        }
                        onClick={() => handleThemeChange(theme.id)}
                        aria-pressed={active}
                        aria-label={theme.name}
                        title={theme.name}
                      >
                        {active && <Check size={15} strokeWidth={3} color={theme.swatchCheck} />}
                      </button>
                    )
                  })}
                </div>

                <div className="settings-divider" />
                <div className="settings-row-item">
                  <div className="settings-row-text">
                    <span className="settings-row-title">Claridad del vidrio</span>
                    <span className="settings-row-desc">Qué tan transparentes se ven la tab bar y el mini-player</span>
                  </div>
                </div>
                <div className="settings-glass-picker" role="radiogroup" aria-label="Claridad del vidrio">
                  {GLASS_CLARITY_OPTIONS.map((opt) => (
                    <button
                      key={opt.id}
                      type="button"
                      role="radio"
                      aria-checked={currentGlassClarity === opt.id}
                      className={`settings-glass-option settings-glass-option--${opt.id} ${currentGlassClarity === opt.id ? 'active' : ''}`}
                      onClick={() => handleGlassClarityChange(opt.id)}
                    >
                      <span className="settings-glass-option-swatch" aria-hidden="true" />
                      <span className="settings-glass-option-text">
                        <span className="settings-glass-option-label">{opt.label}</span>
                        <span className="settings-glass-option-desc">{opt.desc}</span>
                      </span>
                      {currentGlassClarity === opt.id && <Check size={14} strokeWidth={3} />}
                    </button>
                  ))}
                </div>

                {customThemes.length > 0 && (
                  <>
                    <div className="settings-divider" />
                    <ul className="settings-custom-theme-list">
                      {customThemes.map((theme) => {
                        const active = currentTheme === theme.id
                        return (
                          <li key={theme.id} className={`settings-custom-theme-item ${active ? 'active' : ''}`}>
                            <button
                              type="button"
                              className="settings-custom-theme-dot"
                              style={
                                {
                                  '--swatch': theme.colors['--accent'],
                                  '--swatch-bg': theme.colors['--bg'],
                                } as CSSProperties
                              }
                              onClick={() => handleApplyCustomTheme(theme)}
                              aria-label={`Aplicar ${theme.name}`}
                            >
                              {active && <Check size={13} strokeWidth={3} />}
                            </button>
                            <span className="settings-custom-theme-name">{theme.name}</span>
                            <button
                              type="button"
                              className="settings-custom-theme-delete"
                              onClick={() => handleDeleteCustomTheme(theme)}
                              aria-label={`Eliminar ${theme.name}`}
                            >
                              <Trash2 size={13} />
                            </button>
                          </li>
                        )
                      })}
                    </ul>
                  </>
                )}

                <div className="settings-divider" />
                <div className="settings-row-item settings-row-item--action">
                  <button
                    type="button"
                    className="settings-theme-creator-toggle"
                    onClick={() => setShowThemeCreator((v) => !v)}
                  >
                    {showThemeCreator ? <X size={14} /> : <Plus size={14} />}
                    {showThemeCreator ? 'Cancelar' : 'Crear tema personalizado'}
                  </button>
                </div>

                {showThemeCreator && (
                  <form className="settings-theme-creator" onSubmit={handleCreateCustomTheme}>
                    <input
                      className="settings-theme-creator-name"
                      value={creatorName}
                      onChange={(e) => setCreatorName(e.target.value)}
                      placeholder="Nombre del tema"
                      maxLength={30}
                    />
                    <div className="settings-theme-creator-colors">
                      <label className="settings-theme-creator-color">
                        <input type="color" value={creatorBg} onChange={(e) => setCreatorBg(e.target.value)} />
                        <span>Fondo</span>
                      </label>
                      <label className="settings-theme-creator-color">
                        <input
                          type="color"
                          value={creatorBgElevated}
                          onChange={(e) => setCreatorBgElevated(e.target.value)}
                        />
                        <span>Fondo secundario</span>
                      </label>
                      <label className="settings-theme-creator-color">
                        <input type="color" value={creatorAccent} onChange={(e) => setCreatorAccent(e.target.value)} />
                        <span>Acento</span>
                      </label>
                      <label className="settings-theme-creator-color">
                        <input type="color" value={creatorInk} onChange={(e) => setCreatorInk(e.target.value)} />
                        <span>Texto</span>
                      </label>
                    </div>
                    <button type="submit" className="settings-theme-creator-save">
                      Guardar y aplicar
                    </button>
                  </form>
                )}
              </section>
            )}

            {activeCategory === 'playback' && (
              <section className="settings-group" style={{ '--row-tint': CATEGORY_TINT[activeCategory] } as CSSProperties}>
                <div className="settings-row-item">
                  <div className="settings-row-icon">
                    <Sparkles size={16} />
                  </div>
                  <div className="settings-row-text">
                    <span className="settings-row-title">Reproducción automática</span>
                    <span className="settings-row-desc">Sigue con música parecida cuando la cola termina.</span>
                  </div>
                  <button
                    className={`settings-toggle ${autoplayEnabled ? 'on' : ''}`}
                    role="switch"
                    aria-checked={autoplayEnabled}
                    onClick={() => setAutoplayEnabled(!autoplayEnabled)}
                  >
                    <span className="settings-toggle-knob" />
                  </button>
                </div>
                <div className="settings-row-item">
                  <div className="settings-row-icon">
                    <Radio size={16} />
                  </div>
                  <div className="settings-row-text">
                    <span className="settings-row-title">Segundo plano</span>
                    <span className="settings-row-desc">
                      Controla la música desde la pantalla de bloqueo. Mientras el caché de una canción se prepara suena
                      vía YouTube y eso SÍ corta al bloquear (Google lo bloquea desde temprano 2026); apenas queda lista
                      pasa sola a audio propio que sigue sin cortes — avisamos con notificación.
                    </span>
                  </div>
                </div>
                <div className="settings-row-item">
                  <div className="settings-row-icon">
                    <EyeOff size={16} />
                  </div>
                  <div className="settings-row-text">
                    <span className="settings-row-title">Sesión privada</span>
                    <span className="settings-row-desc">
                      Lo que escuches mientras está activa no suma a tu historial ni a "Para ti". Solo en este dispositivo.
                    </span>
                  </div>
                  <button
                    className={`settings-toggle ${privateSession ? 'on' : ''}`}
                    role="switch"
                    aria-checked={privateSession}
                    onClick={handleTogglePrivateSession}
                  >
                    <span className="settings-toggle-knob" />
                  </button>
                </div>
                <div className="settings-row-item">
                  <div className="settings-row-icon">
                    <WifiOff size={16} />
                  </div>
                  <div className="settings-row-text">
                    <span className="settings-row-title">Ahorro de datos</span>
                    <span className="settings-row-desc">
                      Frena la precarga en segundo plano de las próximas canciones de la cola. La que estás escuchando
                      sigue sonando igual.
                    </span>
                  </div>
                  <button
                    className={`settings-toggle ${dataSaver ? 'on' : ''}`}
                    role="switch"
                    aria-checked={dataSaver}
                    onClick={handleToggleDataSaver}
                  >
                    <span className="settings-toggle-knob" />
                  </button>
                </div>
                <div className="settings-row-item">
                  <div className="settings-row-icon">
                    <SkipForward size={16} />
                  </div>
                  <div className="settings-row-text">
                    <span className="settings-row-title">Saltar sponsors (SponsorBlock)</span>
                    <span className="settings-row-desc">
                      Saltea automáticamente segmentos de sponsor/auto-promoción reportados por la comunidad de
                      SponsorBlock en las canciones que vienen de YouTube.
                    </span>
                  </div>
                  <button
                    className={`settings-toggle ${sponsorBlock ? 'on' : ''}`}
                    role="switch"
                    aria-checked={sponsorBlock}
                    onClick={handleToggleSponsorBlock}
                  >
                    <span className="settings-toggle-knob" />
                  </button>
                </div>
                <div className="settings-row-item">
                  <div className="settings-row-icon">
                    <Music4 size={16} />
                  </div>
                  <div className="settings-row-text">
                    <span className="settings-row-title">Scrobbling (Last.fm / ListenBrainz)</span>
                    <span className="settings-row-desc">
                      Manda cada canción escuchada (pasada la mitad, o 4 minutos) a tu cuenta de Last.fm y/o
                      ListenBrainz. Respeta la sesión privada: si está activa, no se scrobblea nada.
                    </span>
                  </div>
                  <button
                    className={`settings-toggle ${scrobbleEnabled ? 'on' : ''}`}
                    role="switch"
                    aria-checked={scrobbleEnabled}
                    onClick={handleToggleScrobble}
                  >
                    <span className="settings-toggle-knob" />
                  </button>
                </div>
                {scrobbleEnabled && (
                  <div className="settings-row-item" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
                    <button
                      type="button"
                      className="settings-scrobble-toggle-link settings-row-title"
                      onClick={() => setShowScrobbleSetup((v) => !v)}
                    >
                      {showScrobbleSetup ? 'Ocultar credenciales' : 'Configurar credenciales de scrobbling'}
                    </button>
                    {showScrobbleSetup && (
                      <form className="settings-scrobble-form" onSubmit={handleSaveScrobbleCreds}>
                        <span className="settings-row-desc">
                          ListenBrainz: pegá tu user token (Configuración de tu perfil en listenbrainz.org).
                        </span>
                        <input
                          className="settings-scrobble-input"
                          placeholder="Token de ListenBrainz"
                          value={scrobbleCreds.listenbrainzToken}
                          onChange={(e) => setScrobbleCredsState((c) => ({ ...c, listenbrainzToken: e.target.value }))}
                        />
                        <span className="settings-row-desc">
                          Last.fm: necesita una API key/secret (last.fm/api/account/create) y una session key ya
                          autorizada (Last.fm no permite obtenerla sin un paso de autorización manual del usuario).
                        </span>
                        <input
                          className="settings-scrobble-input"
                          placeholder="API key de Last.fm"
                          value={scrobbleCreds.lastfmApiKey}
                          onChange={(e) => setScrobbleCredsState((c) => ({ ...c, lastfmApiKey: e.target.value }))}
                        />
                        <input
                          className="settings-scrobble-input"
                          placeholder="API secret de Last.fm"
                          value={scrobbleCreds.lastfmApiSecret}
                          onChange={(e) => setScrobbleCredsState((c) => ({ ...c, lastfmApiSecret: e.target.value }))}
                        />
                        <input
                          className="settings-scrobble-input"
                          placeholder="Session key de Last.fm"
                          value={scrobbleCreds.lastfmSessionKey}
                          onChange={(e) => setScrobbleCredsState((c) => ({ ...c, lastfmSessionKey: e.target.value }))}
                        />
                        <button type="submit" className="settings-scrobble-save">
                          Guardar credenciales
                        </button>
                      </form>
                    )}
                  </div>
                )}
                <ReleaseWatchRow />
              </section>
            )}

            {activeCategory === 'sources' && (
              <section className="settings-group" style={{ '--row-tint': CATEGORY_TINT[activeCategory] } as CSSProperties}>
                {sourcePlugins.map((plugin) => (
                  <div className="settings-row-item" key={plugin.id}>
                    <div className="settings-row-icon">
                      <Puzzle size={16} />
                    </div>
                    <div className="settings-row-text">
                      <span className="settings-row-title">{plugin.name}</span>
                      <span className="settings-row-desc">
                        {plugin.id === 'piped'
                          ? 'Fuente alternativa vía Piped — también se usa como respaldo automático si YT Music falla.'
                          : `Búsqueda${plugin.capabilities.resolveStream ? ' y reproducción' : ''} desde ${plugin.name}.`}
                      </span>
                    </div>
                    <button
                      className={`settings-toggle ${pluginEnabledMap[plugin.id] ? 'on' : ''}`}
                      role="switch"
                      aria-checked={!!pluginEnabledMap[plugin.id]}
                      onClick={() => handleTogglePlugin(plugin.id)}
                    >
                      <span className="settings-toggle-knob" />
                    </button>
                  </div>
                ))}
              </section>
            )}

            {activeCategory === 'storage' && (
              <section className="settings-group" style={{ '--row-tint': CATEGORY_TINT[activeCategory] } as CSSProperties}>
                <div className="settings-row-item">
                  <div className="settings-row-icon">
                    <HardDrive size={16} />
                  </div>
                  <div className="settings-row-text">
                    <span className="settings-row-title">Audio y portadas</span>
                    <span className="settings-row-desc">{assetStats.count} archivos en el dispositivo</span>
                  </div>
                  <span className="settings-row-stat">
                    {formatBytes(assetStats.totalBytes)} <span className="settings-row-stat-max">/ {formatBytes(assetStats.quotaBytes)}</span>
                  </span>
                </div>
                <div className="settings-cache-bar">
                  <div className="settings-cache-bar-fill" style={{ transform: `scaleX(${audioPct / 100})` }} />
                </div>

                {activeDownloads.length > 0 && (
                  <div className="settings-row-item settings-row-item--compact">
                    <div className="settings-row-icon settings-row-icon--sm">
                      <Download size={14} />
                    </div>
                    <div className="settings-row-text">
                      <span className="settings-row-title settings-row-title--sm">Descargando ({activeDownloads.length})</span>
                      <span className="settings-row-desc">
                        {activeDownloads
                          .map((d) =>
                            d.total ? `${Math.round((d.loaded / d.total) * 100)}%` : 'en curso…',
                          )
                          .join(' · ')}
                      </span>
                    </div>
                  </div>
                )}

                <div className="settings-row-item settings-row-item--action">
                  <button className="settings-cache-clear" onClick={handleClearAudioCache}>
                    <Trash2 size={14} />
                    Vaciar audio y portadas
                  </button>
                </div>

                <div className="settings-divider" />

                {metaStats.map((s) => {
                  const Icon = META_ICONS[s.key] || HardDrive
                  return (
                    <div className="settings-row-item settings-row-item--compact" key={s.key}>
                      <div className="settings-row-icon settings-row-icon--sm">
                        <Icon size={14} />
                      </div>
                      <div className="settings-row-text">
                        <span className="settings-row-title settings-row-title--sm">{s.label}</span>
                      </div>
                      <span className="settings-row-stat settings-row-stat--sm">{s.count}</span>
                    </div>
                  )
                })}
                <div className="settings-row-item settings-row-item--action">
                  <span className="settings-row-desc">
                    {metaTotalCount} entradas · {formatBytes(metaTotalBytes)}
                  </span>
                  <button className="settings-cache-clear" onClick={handleClearMetadataCache}>
                    <Trash2 size={14} />
                    Vaciar metadatos
                  </button>
                </div>

                <div className="settings-divider" />

                <div className="settings-row-item settings-row-item--action">
                  <div className="settings-row-text">
                    <span className="settings-row-title">Historial de escucha</span>
                    <span className="settings-row-desc">Solo en este dispositivo · usado por "Para ti"</span>
                  </div>
                  <button className="settings-cache-clear" onClick={handleClearListeningHistory}>
                    <Trash2 size={14} />
                    Borrar
                  </button>
                </div>
              </section>
            )}
              </motion.div>
            </AnimatePresence>
          </motion.div>
        )}
        </AnimatePresence>
      </div>
    </div>
  )
}
