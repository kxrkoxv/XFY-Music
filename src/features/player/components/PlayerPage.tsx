import { useNavigate } from 'react-router-dom'
import { smartGoBack } from '@shared/lib/backStack'
import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import {
  ArrowLeft,
  ChevronDown,
  Heart,
  Shuffle,
  Sparkles,
  SkipBack,
  SkipForward,
  Volume2,
  Mic,
  MicOff,
} from 'lucide-react'
import { MorphIcon } from 'morphicons/react'
// morphicons consumes icon *data* (IconNode), not lucide-react's rendered components —
// these four have to come from the `lucide` data package, only for MorphIcon's `icon` prop.
import { Play, Pause, Repeat, Repeat1 } from 'lucide'
import { usePlayerStore } from '@features/player/store/usePlayerStore'
import { useAuthStore, isSongFavorite } from '@features/auth'
import { lookupArtistInfo } from '@services/api/audiodb'
import { LyricsPanel, DynamicBackground, useAdaptiveTheme } from '@features/lyrics'
import MotionArt from '@features/player/components/MotionArt'
import { EASE_OUT, LAYOUT_SPRING } from '@shared/lib/motionTokens'
import { useCachedImageSrc } from '@shared/lib/useCachedImageSrc'
import ArtistLinks from '@shared/components/ArtistLinks'
import useCanHover from '@shared/lib/useCanHover'
import useScreenWakeLock from '@shared/lib/useScreenWakeLock'
import { translateGenre } from '@shared/lib/genres'
import { useArtworkStore } from '@features/player/store/useArtworkStore'
import type { ArtistInfo } from '@/types/models'
import './PlayerPage.css'

const SHOW_LYRICS_KEY = 'xfy_show_lyrics'

function readShowLyricsPref() {
  try {
    const raw = localStorage.getItem(SHOW_LYRICS_KEY)
    return raw === null ? true : raw === 'true'
  } catch {
    return true
  }
}

function formatTime(seconds: number) {
  if (!Number.isFinite(seconds)) return '0:00'
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

export default function PlayerPage() {
  const navigate = useNavigate()
  const {
    queue,
    currentIndex,
    isPlaying,
    currentTime,
    duration,
    isShuffle,
    smartShuffle,
    repeatMode,
    volume,
    toggle,
    next,
    previous,
    seek,
    cycleShuffleMode,
    cycleRepeat,
    setVolume,
    isBuffering,
  } = usePlayerStore()
  const { currentUser, toggleFavorite } = useAuthStore()
  // Con reduced-motion el video MotionArt no se monta: es la superficie con
  // más movimiento continuo de toda la app y no aporta información (solo
  // ambiente), exactamente lo que estos usuarios piden reducir.
  const reduceMotion = useReducedMotion()
  const [showLyrics, setShowLyrics] = useState(readShowLyricsPref)
  const canHover = useCanHover()

  // Wake Lock: pantalla encendida mientras suenan las letras karaoke — la
  // API libera sola al ocultar la pestaña y el hook re-adquiere al volver
  // (ver useScreenWakeLock); sin red de seguridad extra acá.
  const wakeLockActive = showLyrics && isPlaying
  useScreenWakeLock(wakeLockActive)

  const song = queue[currentIndex]

  // Doble-click/doble-tap sobre la carátula (estilo Instagram): alterna
  // favorito y dispara el pop del corazón grande sobre la foto. Se
  // detecta a mano en vez de depender solo de onDoubleClick porque en
  // touch los navegadores no siempre generan un evento "dblclick" nativo
  // confiable — comparar el timestamp entre taps sí funciona en ambos.
  const lastTapRef = useRef(0)
  const [heartPop, setHeartPop] = useState<{ id: number; liked: boolean } | null>(null) // { id, liked } | null
  const handleArtTap = () => {
    if (!song) return
    const now = Date.now()
    const isDoubleTap = now - lastTapRef.current < 320
    lastTapRef.current = now
    if (!isDoubleTap) return
    lastTapRef.current = 0
    const nowFavorite = !isSongFavorite(currentUser, song.id)
    toggleFavorite(song)
    setHeartPop({ id: now, liked: nowFavorite })
  }

  const resolveArtwork = useArtworkStore((s) => s.resolve)
  const artworkMap = useArtworkStore((s) => s.artwork)
  const songId = song?.id
  useEffect(() => {
    if (songId) resolveArtwork({ id: songId, title: song?.title, artist: song?.artist, albumArtUrl: song?.albumArtUrl })
  }, [songId, resolveArtwork, song?.title, song?.artist, song?.albumArtUrl])
  // Apple Music en cuanto resuelve; el thumbnail de YT Music mientras tanto.
  const artwork = song ? artworkMap[String(song.id)] || song.albumArtUrl : null
  const cachedArtwork = useCachedImageSrc(artwork)
  const [lyricsAvailable, setLyricsAvailable] = useState(true)

  // La pista está sonando por IFrame mientras el server extrae y sube el
  // audio al blob compartido: chip discreto de "preparando" para que el
  // usuario entienda POR QUÉ conviene no cerrar la app todavía.
  const ytPreparing = usePlayerStore((s) => s._ytFallbackStage === 'iframe' && s.isBuffering)

  // Accent theme: cover color, or (when active) the MotionArt background's live color.
  const [motionVideoEl, setMotionVideoEl] = useState<HTMLVideoElement | null>(null)
  const [motionVideoActive, setMotionVideoActive] = useState(false)
  const adaptiveTheme = useAdaptiveTheme({
    coverUrl: cachedArtwork || artwork || undefined,
    videoEl: motionVideoEl,
    videoActive: motionVideoActive,
  })

  const [artistInfo, setArtistInfo] = useState<ArtistInfo | null | undefined>(undefined)
  const artistName = song?.artist
  // Se inicializa en null (no en `artistName`) a propósito: si arrancara con el mismo
  // valor que `artistName`, el efecto de abajo nunca dispararía la primera búsqueda de
  // datos del artista al abrir el reproductor por primera vez (solo lo haría al cambiar
  // de canción, porque recién ahí `prevArtistNameRef.current !== artistName` sería true).
  // Eso dejaba el placeholder "Cargando datos del artista…" pegado para siempre en la
  // primera canción reproducida.
  const prevArtistNameRef = useRef<string | null | undefined>(null)

  useEffect(() => {
    if (!song) {
      navigate('/', { replace: true })
      return
    }

    let active = true
    if (artistName && prevArtistNameRef.current !== artistName) {
      setArtistInfo(undefined)
      prevArtistNameRef.current = artistName
      lookupArtistInfo(artistName).then((info) => {
        if (active) setArtistInfo(info || null)
      })
    }

    return () => {
      active = false
    }
  }, [song, navigate, artistName])

  useEffect(() => {
    try {
      localStorage.setItem(SHOW_LYRICS_KEY, String(showLyrics))
    } catch {
      // Ignore if localStorage is unavailable.
    }
  }, [showLyrics])

  // Assume lyrics are available upon track change until the fetch completes.
  const prevSongIdRef = useRef(song?.id)
  useEffect(() => {
    if (prevSongIdRef.current !== song?.id) {
      setLyricsAvailable(true)
      prevSongIdRef.current = song?.id
    }
  }, [song?.id, setLyricsAvailable])

  // Landscape móvil (mismo media query que el breakpoint grid del CSS).
  // Define cómo sale .lyrics-body: en landscape usa popLayout (el panel
  // saliente se ancla absoluto y fadea MIENTRAS el resto viaja a su nueva
  // posición — una sola motion continua); en vertical la salida es el
  // collapse de altura en flujo, que ya se lee bien.
  const [isLandscape, setIsLandscape] = useState(false)
  useEffect(() => {
    const mq = window.matchMedia('(max-height: 500px) and (orientation: landscape)')
    const update = () => setIsLandscape(mq.matches)
    update()
    mq.addEventListener('change', update)
    return () => mq.removeEventListener('change', update)
  }, [])

  if (!song) return null

  const isFavorite = isSongFavorite(currentUser, song.id)
  const progressPct = duration > 0 ? (currentTime / duration) * 100 : 0

  return (
    <div
      className="player-page"
      style={{
        '--accent': adaptiveTheme.accent,
        '--accent-strong': adaptiveTheme.accentStrong,
        '--accent-dim': adaptiveTheme.accentDim,
        '--accent-glow': adaptiveTheme.accentGlow,
      } as CSSProperties}
    >
      <div className="player-bg" style={{ backgroundImage: `url("${cachedArtwork || artwork}")` }} />
      {/* Motion Art Background: siempre se intenta cargar el HLS desenfocado.
          Si la canción tiene MotionArt (motionVideoActive=true), ese es el fondo.
          Si no, se usa DynamicBackground (WebGL) — igual sin importar si el
          audio suena por <audio> real o por el IFrame de YouTube. El IFrame
          de YouTube (#yt-engine-mount) queda siempre oculto (1×1, ver
          global.css): es pura fuente de audio, nunca se muestra como video,
          para que el fallback a IFrame sea inaudible E invisible. */}
      {!reduceMotion && (
        <MotionArt
          song={song}
          type="background"
          onVideoRef={setMotionVideoEl}
          onActiveChange={setMotionVideoActive}
          isPlaying={isPlaying}
        />
      )}

      {/* Fondo animado (WebGL, Kawarp) para cualquier pista sin MotionArt —
          se mantiene igual sin importar si el audio suena por <audio> real
          o (temporalmente) por el IFrame de YouTube: el fallback de YouTube
          nunca debe notarse a nivel visual, solo resuelve el audio. */}
      {!motionVideoActive && (
        <DynamicBackground coverUrl={cachedArtwork || artwork} className="spicy-dynamic-bg" tintRgbFloat={adaptiveTheme.rgbFloat} isPlaying={isPlaying} />
      )}
      <div className="player-bg-scrim" />

      {createPortal(
          <motion.button
            className="player-back"
            onClick={() => smartGoBack(navigate, '/')}
            initial={reduceMotion ? { opacity: 0 } : { opacity: 0, x: -16, scale: 0.9 }}
            animate={reduceMotion ? { opacity: 1 } : { opacity: 1, x: 0, scale: 1 }}
            exit={reduceMotion ? { opacity: 0 } : { opacity: 0, x: -16, scale: 0.9 }}
            transition={{ type: 'spring', stiffness: 400, damping: 28 }}
            whileHover={canHover ? { scale: 1.05 } : undefined}
            whileTap={{ scale: 0.92 }}
          >
            <ArrowLeft size={18} />
            <span>Atrás</span>
          </motion.button>,
          document.body,
        )}

      {/* Estado de layout por CLASE, no por :has(): los selectores :has()
          solo cambian cuando .lyrics-body entra/sale del DOM, y
          AnimatePresence lo mantiene montado durante toda la salida — el
          reflujo llegaba TARDE (dos fases: fade quieto + salto). Con la
          clase, el grid se re-fluye al instante del toggle y el FLIP
          arranca en paralelo con la salida. */}
      <div className={`player-content ${lyricsAvailable && !showLyrics ? 'lyrics-hidden' : ''}`}>
      {/* FLIP de layout: en landscape, mostrar/ocultar letras re-fluye el
          grid (2 columnas ↔ 1 centrada). Sin `layout`, player-main y sus
          bloques TELETRANSPORTAN a su nueva posición de golpe; con
          `layout`, motion mide antes/después y anima el trayecto con
          transforms (GPU, cero recálculo de layout por frame). Los hijos
          con layout="position" son de tamaño fijo: se corrigen contra la
          escala del padre para no estirarse durante el vuelo (la carátula
          deformándose en óvalo es justo el "bug" que quería evitarse).
          El texto no lleva layout a propósito: reflowea al instante y el
          escalado de texto sí se nota. Reduced-motion: reflujo instantáneo
          — para movimiento grande, lo más amable es que no haya animación. */}
      <motion.div
        className="player-main"
        layout={reduceMotion ? false : true}
        transition={{ layout: LAYOUT_SPRING }}
      >
      <div className="player-art-block">
            <motion.div
              className="player-art-crossfade"
              layout={reduceMotion ? false : 'position'}
              transition={{ layout: LAYOUT_SPRING }}
              onClick={handleArtTap}
            >
              <AnimatePresence mode="popLayout" initial={false}>
                <motion.div
                  key={song.id}
                  className="player-art-wrapper"
                  initial={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 1.04 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.97 }}
                  transition={{ duration: 0.35, ease: [0.4, 0, 0.2, 1] }}
                >
                  <img
                    className="player-art"
                    src={cachedArtwork || artwork || undefined}
                    alt=""
                    referrerPolicy="no-referrer"
                    draggable={false}
                    onError={(e) => {
                      if (!e.currentTarget.src.endsWith('/icons/icon-192.png')) e.currentTarget.src = '/icons/icon-192.png'
                    }}
                  />
                  {/* Portada animada: igual criterio que el fondo — con
                      reduced-motion se queda la foto estática. */}
                  {!reduceMotion && <MotionArt song={song} type="cover" isPlaying={isPlaying} />}
                </motion.div>
              </AnimatePresence>

              {/* Pop grande estilo Instagram al doble-tap — decorativo, no
                  intercepta clicks (el botón real de abajo sí es accesible).
                  Con reduced-motion no se renderiza: es puro movimiento. */}
              <AnimatePresence>
                {!reduceMotion && heartPop && (
                  <motion.div
                    key={heartPop.id}
                    className="player-art-heart-pop"
                    aria-hidden="true"
                    initial={{ opacity: 0, scale: 0.5 }}
                    animate={{ opacity: [0, 1, 1, 0], scale: [0.5, 1.15, 1, 1] }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.85, times: [0, 0.35, 0.75, 1], ease: [0.16, 1, 0.3, 1] }}
                    onAnimationComplete={() => setHeartPop(null)}
                  >
                    <Heart size={72} fill={heartPop.liked ? '#fff' : 'none'} color="#fff" strokeWidth={heartPop.liked ? 0 : 2} />
                  </motion.div>
                )}
              </AnimatePresence>

              <button
                className="player-fav-btn"
                aria-label={isFavorite ? 'Quitar de favoritas' : 'Añadir a favoritas'}
                onClick={(e) => {
                  e.stopPropagation()
                  toggleFavorite(song)
                }}
              >
                <Heart size={17} fill={isFavorite ? 'var(--accent-strong)' : 'none'} color={isFavorite ? 'var(--accent-strong)' : '#fff'} />
              </button>
            </motion.div>
            <div className="player-track-info">
              <h1>{song.title}</h1>
              <ArtistLinks song={song} className="player-artist-link" />
              {artistInfo === undefined ? (
                <p className="player-artist-meta-placeholder">Cargando datos del artista…</p>
              ) : artistInfo ? (
                <div className="player-artist-meta">
                  {artistInfo.genre && <span>{translateGenre(artistInfo.genre)}</span>}
                  {artistInfo.country && <span>{artistInfo.country}</span>}
                  {artistInfo.yearFormed && <span>{artistInfo.yearFormed}</span>}
                </div>
              ) : null}
            </div>
          </div>

          <motion.div
            className="player-progress-block"
            layout={reduceMotion ? false : 'position'}
            transition={{ layout: LAYOUT_SPRING }}
          >
            <AnimatePresence>
              {ytPreparing && (
                <motion.div
                  className={`player-prepare-chip${reduceMotion ? '' : ' is-animated'}`}
                  initial={{ opacity: 0, y: -4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -4 }}
                >
                  <span className="player-prepare-spinner" aria-hidden="true" />
                  <span className="player-prepare-text">
                    <span className="player-prepare-title">Preparando audio</span>
                    <span className="player-prepare-subtitle">Sonando por YouTube mientras se cachea…</span>
                  </span>
                </motion.div>
              )}
            </AnimatePresence>
            <input
              type="range"
              className="player-progress"
              min={0}
              max={duration || 0}
              value={currentTime}
              onChange={(e) => seek(Number(e.target.value))}
              style={{ '--progress': `${progressPct}%` } as CSSProperties}
            />
            <div className="player-time-row">
              <span>{formatTime(currentTime)}</span>
              <span>{formatTime(duration)}</span>
            </div>
          </motion.div>

          <motion.div
            className="player-controls"
            layout={reduceMotion ? false : 'position'}
            transition={{ layout: LAYOUT_SPRING }}
          >
            <button
              className={`player-control-btn ${isShuffle || smartShuffle ? 'active' : ''}`}
              aria-label={smartShuffle ? 'Smart Shuffle activado' : isShuffle ? 'Aleatorio activado' : 'Aleatorio'}
              title={smartShuffle ? 'Smart Shuffle: suma canciones que pegan con la vibra' : 'Aleatorio'}
              onClick={cycleShuffleMode}
            >
              {smartShuffle ? (
                <span className="player-shuffle-smart-icon">
                  <Shuffle size={18} />
                  <Sparkles size={10} className="player-shuffle-smart-badge" />
                </span>
              ) : (
                <Shuffle size={18} />
              )}
            </button>
            <button className="player-control-btn" aria-label="Anterior" onClick={previous}>
              <SkipBack size={20} fill="currentColor" />
            </button>
            <motion.button
              className={`player-play-btn${isBuffering ? ' is-buffering' : ''}`}
              aria-label={isPlaying ? 'Pausar' : 'Reproducir'}
              aria-busy={isBuffering}
              onClick={toggle}
              whileTap={{ scale: 0.88 }}
            >
              {/* Aro que gira mientras el motor activo está resolviendo
                  audio real (blob CDN pendiente, o esperando al IFrame) —
                  antes no había NINGÚN indicador acá: el botón mostraba
                  "Pausa" fijo aunque todavía no sonara nada. */}
              {isBuffering && <span className="player-play-btn-ring" aria-hidden="true" />}
              <MorphIcon icon={isPlaying ? Pause : Play} size={24} fill="currentColor" spring="snappy" reducedMotion="user" />
            </motion.button>
            <button className="player-control-btn" aria-label="Siguiente" onClick={next}>
              <SkipForward size={20} fill="currentColor" />
            </button>
            <motion.button
              className={`player-control-btn ${repeatMode !== 0 ? 'active' : ''}`}
              aria-label="Repetir"
              onClick={cycleRepeat}
              whileTap={{ scale: 0.88 }}
            >
              <MorphIcon icon={repeatMode === 1 ? Repeat1 : Repeat} size={18} spring="snappy" reducedMotion="user" />
            </motion.button>
          </motion.div>

          <motion.div
            className="player-volume-connect-row"
            layout={reduceMotion ? false : 'position'}
            transition={{ layout: LAYOUT_SPRING }}
          >
            <div className="player-volume-row">
              <Volume2 size={16} />
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={volume}
                onChange={(e) => setVolume(Number(e.target.value))}
                style={{ '--progress': `${volume * 100}%` } as CSSProperties}
              />
            </div>
          </motion.div>
        </motion.div>

        {lyricsAvailable && (
          <motion.div
            layout={reduceMotion ? false : true}
            transition={{ layout: LAYOUT_SPRING }}
            className={`lyrics-header ${!showLyrics ? 'lyrics-header--collapsed' : ''}`}
          >
            {/* Crossfade entre variantes del header (fila compacta ↔ tarjeta
                reveal): la caja contenedora la anima el `layout` de arriba;
                esto solo suaviza el intercambio de contenido interno. */}
            <AnimatePresence mode="popLayout" initial={false}>
              {showLyrics ? (
                <motion.div
                  key="expanded"
                  className="lyrics-header-inner"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.15, ease: 'easeOut' }}
                >
                  <span className="lyrics-header-label">Letra</span>
                  <div className="lyrics-header-actions">
                    <button
                      className="player-control-btn"
                      aria-label="Ocultar letras"
                      onClick={() => setShowLyrics(false)}
                    >
                      <Mic size={16} />
                    </button>
                  </div>
                </motion.div>
              ) : (
                // Con las letras ocultas antes quedaba solo un ícono chico
                // suelto en una fila vacía — acá se muestra como una tarjeta
                // completa, clickeable en toda su superficie, que invita a
                // mostrarlas en vez de sentirse como un resto de layout.
                <motion.button
                  key="collapsed"
                  className="lyrics-header-reveal"
                  onClick={() => setShowLyrics(true)}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.15, ease: 'easeOut' }}
                >
                  <span className="lyrics-header-reveal-icon">
                    <MicOff size={16} />
                  </span>
                  <span className="lyrics-header-reveal-text">
                    <strong>Letra</strong>
                    <small>Toca para mostrar</small>
                  </span>
                  <ChevronDown size={16} className="lyrics-header-reveal-chevron" />
                </motion.button>
              )}
            </AnimatePresence>
          </motion.div>
        )}

        {/* popLayout en landscape: el panel saliente sale del flujo AL
            INSTANTE (anclado absoluto por motion, con su tamaño medido) y
            fadea en su lugar mientras player-main y el header viajan en
            paralelo — una sola motion, no dos fases. En vertical la salida
            en flujo (height→0) ya se lee bien y es la que sigue. Sin
            animación de altura en landscape: la ventana la define el grid,
            no el inline style. */}
        <AnimatePresence mode={isLandscape ? 'popLayout' : 'sync'}>
          {showLyrics && (
            <motion.div
              className="lyrics-body"
              initial={reduceMotion || isLandscape ? { opacity: 0 } : { opacity: 0, height: 0 }}
              animate={isLandscape ? { opacity: 1 } : { opacity: 1, height: 'auto' }}
              exit={reduceMotion || isLandscape ? { opacity: 0 } : { opacity: 0, height: 0 }}
              transition={{ duration: 0.28, ease: EASE_OUT }}
              style={{ overflow: 'hidden' }}
            >
              <LyricsPanel song={song} artworkUrl={cachedArtwork || artwork} onAvailabilityChange={setLyricsAvailable} />
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  )
}