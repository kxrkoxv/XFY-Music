import { create } from 'zustand'
import { toast } from 'sonner'
import { enqueueDownload, prefetch } from '@features/player/lib/downloadQueue'
import { prefetchQueueAhead } from '@features/player/lib/smartCache'
import {
  getCachedAudioUrl,
  resolveCachedAudio,
  requestCache,
  watchCacheReady,
} from '@features/player/lib/ytblob'
import { findAlternateStream } from '@services/plugins/crossSourceFallback'
import { getCachedAssetIfPresent } from '@shared/lib/cacheManager'
import { recordListen, recordPlaytime, FLUSH_INTERVAL_MS } from '@shared/lib/metrics'
import { scrobble } from '@shared/lib/scrobble'
import { getSponsorSegments, isSponsorBlockEnabled, findActiveSegment, type SponsorSegment } from '@services/api/sponsorblock'
import { showAppNotification } from '@shared/lib/appNotifications'
import { getAutoplayExtension } from '@features/player/lib/autoplay'
import { getTopArtistRecommendations } from '@features/catalog/lib/recommendations'
import { diagnoseMediaFailure } from '@features/player/lib/mediaPath'
import { getSong } from '@services/api/ytmusic'
import { takeNextFromShuffleBag, buildSmartShuffleQueue, SMART_SHUFFLE_MIN_QUEUE } from '@features/player/lib/smartShuffle'
import { lookupArtistName } from '@services/api/appleClient'
import { primaryArtistName, dedupeSongs, isSameSong, type SongLike } from '@shared/lib/songIdentity'
import type { Song } from '@/types/models'
import { splitArtistNames } from '@shared/lib/artistNames'

/**
 * Shape de canción que maneja el player. Superset de `SongLike` (identidad
 * canónica) con los campos propios de reproducción: fuente, URLs de audio
 * directo, y si es una pista externa (no-YouTube) con descarga propia.
 */
export interface PlayerSong extends SongLike {
  source?: string | null
  audioSrc?: string | null
  streamUrl?: string | null
  isExternal?: boolean
  /** Inyectada por Smart Shuffle, no forma parte de la cola/playlist
   *  original — ver smartShuffle.ts. */
  isRecommended?: boolean
}

/** Controller mínimo que expone YouTubeEngine vía registerYouTubeController. */
export interface YouTubeController {
  play: () => void
  pause: () => void
  stop: () => void
  seek: (time: number) => void
  setVolume: (v: number) => void
  load: (videoId: string, resumeAt?: number) => void
  getCurrentTime?: () => number
}

type Engine = 'audio' | 'youtube'
type YtFallbackStage = 'blob' | 'iframe' | null

const AUTOPLAY_KEY = 'xfy_autoplay_enabled'
function readAutoplayPref(): boolean {
  try {
    const raw = localStorage.getItem(AUTOPLAY_KEY)
    return raw === null ? true : raw === 'true' // Enabled by default.
  } catch {
    return true
  }
}

const AUDIO_VISUALIZER_KEY = 'xfy_audio_visualizer_enabled'
// El visualizador de audio (barras estilo ecualizador) se removió por
// completo: dependía de enrutar el <audio> por una Web Audio API
// (AudioContext), y esa AudioContext queda suspendida sola en iOS Safari
// en varios momentos (bloqueo de pantalla, cambio de pista, la PWA yendo
// a segundo plano) sin que nada la vuelva a arrancar — la canción se
// veía "reproduciendo con normalidad" pero sin sonido, y ningún botón lo
// arreglaba. No vale la pena mantener un parche para eso en una app
// pensada para no necesitar mantenimiento futuro; se prefiere no tocar
// nunca el <audio> real. Este removeItem es solo para limpiar la key de
// quien lo había activado antes de que se quitara la función.
try {
  localStorage.removeItem(AUDIO_VISUALIZER_KEY)
} catch {
  // Ignore if localStorage is unavailable.
}
// Shared promise to prevent concurrent autoplay extensions.
let autoplayExtensionPromise: Promise<void> | null = null

const RECENT_KEY = 'xfy_recently_played_v1'
const RECENT_KEY_LEGACY = 'xfy_recently_played'
const RECENT_MAX = 12
// Maximum consecutive track failures before stopping playback to prevent infinite error loops.
const MAX_CONSECUTIVE_ERRORS = 4

function readRecent(): PlayerSong[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY) ?? localStorage.getItem(RECENT_KEY_LEGACY)
    const songs = raw ? JSON.parse(raw) : []
    if (!Array.isArray(songs)) return []
    // Filter out any corrupt or incomplete entries to prevent UI errors, y
    // deduplica por identidad canónica: limpia en el momento de leer cualquier
    // "recién reproducida" duplicada que haya quedado guardada de antes de este fix.
    return dedupeSongs(songs.filter((s) => s && s.id != null && s.title))
  } catch {
    return []
  }
}

// Store the full song object to maintain metadata since we lack a fixed local catalog.
// Matchea por identidad canónica, no solo por id exacto (ver songIdentity.ts): distintos
// videoId de la misma canción no deben aparecer como dos tarjetas separadas en "Recientes".
function trackRecentlyPlayed(song: PlayerSong): void {
  try {
    let songs = readRecent().filter((s) => !isSameSong(s, song))
    songs.unshift(song)
    songs = songs.slice(0, RECENT_MAX)
    localStorage.setItem(RECENT_KEY, JSON.stringify(songs))
  } catch (e) {
    console.warn('[XFY] No se pudo guardar el historial de reproducciones recientes')
  }
}

// --- Scrobbling (Last.fm / ListenBrainz) ---
// Estado a nivel de módulo, igual criterio que sponsorSegments arriba:
// es derivado de "qué canción/sesión de escucha está en curso", no algo
// que la UI necesite leer reactivamente. Umbral estándar de la industria
// del scrobbling: mitad de la canción o 4 minutos, lo que sea MENOR (y
// un piso de 30s para pistas sin duración conocida).
let scrobbleTrackId: string | null = null
let scrobbleStartedAtSec: number | null = null
let scrobbleAccumMs = 0
let scrobbleFired = false

function updateScrobbleProgress(song: PlayerSong, deltaMs: number): void {
  const id = String(song.id ?? '')
  if (!id) return
  if (scrobbleTrackId !== id) {
    scrobbleTrackId = id
    scrobbleStartedAtSec = Math.floor(Date.now() / 1000)
    scrobbleAccumMs = 0
    scrobbleFired = false
  }
  scrobbleAccumMs += deltaMs
  if (scrobbleFired) return

  const durationMs = (song.duration || 0) * 1000
  const threshold = durationMs > 0 ? Math.min(durationMs * 0.5, 4 * 60 * 1000) : 30 * 1000
  if (scrobbleAccumMs < threshold) return

  scrobbleFired = true
  scrobble({
    title: song.title || '',
    artist: primaryArtistName(song) || song.artist || '',
    album: song.album || null,
    durationSec: song.duration || null,
    startedAtSec: scrobbleStartedAtSec || Math.floor(Date.now() / 1000),
  }).catch(() => {
    /* scrobble() ya se traga sus propios errores por servicio — esto es
     * solo una red de seguridad extra */
  })
}

// Identify tracks that require the YouTube playback engine.
export function isYouTubeSong(song: PlayerSong | null | undefined): boolean {
  return !!song && song.source === 'youtube' && !!(song.videoId || song.id)
}

// --- SponsorBlock: segmentos de sponsor/self-promo/interacción de la
// canción que suena ahora, para auto-saltarlos. Estado a nivel de módulo
// (no en el store de zustand) porque es puramente derivado de "qué
// videoId está sonando" — mismo patrón que el cache de ytcore.ts. Se
// resetea cada vez que cambia la pista actual (ver _ensureSponsorSegments).
let sponsorSegmentsForId: string | null = null
let sponsorSegments: SponsorSegment[] = []

function ensureSponsorSegmentsLoaded(song: PlayerSong | null | undefined): void {
  if (!song || !isSponsorBlockEnabled() || !isYouTubeSong(song)) return
  const videoId = song.videoId || String(song.id)
  if (sponsorSegmentsForId === videoId) return // ya cargados (o cargando) para esta pista
  sponsorSegmentsForId = videoId
  sponsorSegments = []
  getSponsorSegments(videoId)
    .then((segments) => {
      if (sponsorSegmentsForId === videoId) sponsorSegments = segments
    })
    .catch(() => {
      /* getSponsorSegments ya maneja sus propios fallos — nada que hacer acá */
    })
}

interface PlayerState {
  audioEl: HTMLAudioElement | null
  ytController: YouTubeController | null
  _engine: Engine
  _loadToken: number
  queue: PlayerSong[]
  currentIndex: number
  isPlaying: boolean
  currentTime: number
  duration: number
  isShuffle: boolean
  /** Smart Shuffle (distinto de isShuffle) — cuando está activo, intercala
   *  canciones recomendadas por el radio de YT Music entre las de la cola
   *  original antes de barajar. Ver smartShuffle.ts. */
  smartShuffle: boolean
  /** Evita disparar buildSmartShuffleQueue más de una vez en simultáneo
   *  (p. ej. si el usuario togglea rápido). */
  _buildingSmartShuffle: boolean
  /** Orden restante del "aleatorio inteligente" (shuffle bag) — índices de
   *  `queue` pendientes de sonar antes de que la bolsa se regenere. */
  _shuffleBag: number[]
  repeatMode: 0 | 1 | 2
  volume: number
  isBuffering: boolean
  _blobUrl: string | null
  /**
   * Fuente de audio REAL de la pista actual (URL del blob CDN, o la remota
   * para pistas externas) — la usa el sistema de letras para pedir la
   * alineación palabra-a-palabra contra el archivo exacto que está sonando.
   * `songId` permite saber a qué pista pertenece cuando cambia rápido.
   */
  _activeAudio: { songId: string; videoId: string | null; url: string } | null
  _consecutiveErrors: number
  _ytFallbackStage: YtFallbackStage
  _autoplayBlockedFor: string | null
  autoplayEnabled: boolean
  _extendingAutoplay: boolean
  _listenedMs: number
  _trackListenedMs: number
  _lastTickTime: number
  _metricsSong: PlayerSong | null
  _sessionStartTime: number
  _trackStartReason: import('@shared/lib/metrics').StartReason | null
  _trackStartTime: number
  _autoplayRetryCleanup: (() => void) | null

  setAudioElement: (el: HTMLAudioElement | null) => void
  /**
   * Recrea el elemento <audio> desde cero preservando src/posición/volumen.
   * Cura conocida de las regresiones de WebKit donde el elemento viejo queda
   * "zombie" tras background/reapertura en PWA (iOS 26, bug 295518) y
   * play() sobre él ya nunca suena — un elemento NUEVO con el mismo src sí.
   */
  _recreateAudioEl: () => void
  registerYouTubeController: (controller: YouTubeController) => void
  currentSong: () => PlayerSong | null
  playQueueAt: (songs: PlayerSong[], index: number) => Promise<void>
  playSongRadio: (song: PlayerSong, searchResults?: PlayerSong[]) => Promise<void>
  _extendRadioFromArtist: (seedSong: PlayerSong, contextList?: PlayerSong[]) => Promise<void>
  _loadCurrentAndPlay: () => Promise<void>
  _playViaIframe: (song: PlayerSong, resumeAt?: number) => void
  _attemptYtAudioRecovery: (failedSrc: string) => Promise<boolean>
  _switchYtEngineToAudio: (song: PlayerSong, url: string, token: number) => Promise<void>
  _tryCrossSourceFallback: (song: PlayerSong, token: number) => Promise<void>
  _armAutoplayRetry: (song: PlayerSong) => void
  _retryBlockedAutoplay: () => Promise<boolean>
  _hydrateCurrentSong: (song: PlayerSong) => Promise<void>
  _extendQueueForAutoplay: () => Promise<void>
  setAutoplayEnabled: (enabled: boolean) => void
  _prefetchNext: () => void
  play: () => Promise<void>
  pause: () => void
  toggle: () => void
  next: () => Promise<void>
  previous: () => Promise<void>
  handleEnded: () => Promise<void>
  handleTrackError: () => Promise<void>
  _resetErrorStreak: () => void
  handleYouTubeError: () => Promise<void>
  seek: (time: number) => void
  _trackProgress: (t: number) => void
  _flushMetrics: (endReason?: import('@shared/lib/metrics').EndReason) => void
  setCurrentTime: (t: number) => void
  setDuration: (d: number) => void
  setBuffering: (b: boolean) => void
  _setPlayingFromEngine: (playing: boolean) => void
  toggleShuffle: () => void
  /** Cicla Off → Shuffle → Smart Shuffle → Off (mismo botón, como en la
   *  app oficial de Spotify). En el paso a Smart Shuffle, extiende la cola
   *  de forma async con recomendaciones antes de barajar. */
  cycleShuffleMode: () => void
  cycleRepeat: () => void
  setVolume: (v: number) => void
  getRecentlyPlayed: () => PlayerSong[]
  reset: () => void
}

export const usePlayerStore = create<PlayerState>()((set, get) => ({
  audioEl: null,
  ytController: null,    // YouTube player API registered by YouTubeEngine.
  // Active playback engine ('youtube' or 'audio').
  _engine: 'audio',
  _loadToken: 0,          // Invalidates stale loads on rapid track skipping.
  queue: [],
  currentIndex: -1,
  isPlaying: false,
  currentTime: 0,
  duration: 0,
  isShuffle: false,
  smartShuffle: false,
  _buildingSmartShuffle: false,
  _shuffleBag: [],
  repeatMode: 0, // 0: none, 1: track, 2: queue.
  volume: 0.8,
  isBuffering: false,
  _blobUrl: null, // Object URL of the currently cached external audio.
  _activeAudio: null,
  _consecutiveErrors: 0, // Resets when a track successfully plays.
  // --- Motor de audio de YouTube (arquitectura Blob) ---
  // Etapa activa para la pista actual: 'blob' (audio desde el CDN de
  // Vercel, listo para segundo plano) o 'iframe' (IFrame Player
  // instantáneo mientras el server extrae y sube en background).
  _ytFallbackStage: null,
  // iOS bloquea play() fuera del gesto si hubo awaits intermedios. Cuando
  // pasa, recordamos QUÉ pista quedó bloqueada y armamos un retry al primer
  // toque en cualquier parte de la UI.
  _autoplayBlockedFor: null,
  // --- Smart Autoplay ---
  autoplayEnabled: readAutoplayPref(),
  _extendingAutoplay: false, // Prevents concurrent extensions.
  // --- Listening Metrics ---
  _listenedMs: 0,        // Uncommitted ms since the last totalMs/days heartbeat flush.
  _trackListenedMs: 0,   // Cumulative ms listened for the current track segment (drives completion%).
  _lastTickTime: 0,      // Last seen currentTime for delta calculation.
  _metricsSong: null,    // Snapshot of the currently accumulating song.
  _sessionStartTime: Date.now(),
  _trackStartReason: null,
  _trackStartTime: 0,
  _autoplayRetryCleanup: null, // Remueve el listener 'pointerdown' armado, si hay uno pendiente.

  setAudioElement: (el) => {
    if (el) el.volume = get().volume
    set({ audioEl: el })
  },

  _recreateAudioEl: () => {
    const old = get().audioEl
    if (!old) return
    const src = old.src
    const resumeAt = old.currentTime || 0
    // El zombie de WebKit también se lleva puesto muted/playbackRate al
    // recrear — sin esto, un rescate en segundo plano podía devolver el
    // audio silenciado o a velocidad normal si el usuario tenía 1.25x/1.5x.
    const wasMuted = old.muted
    const rate = old.playbackRate || 1

    const el = wireAudioElement()
    el.volume = get().volume
    el.muted = wasMuted
    el.playbackRate = rate
    set({ audioEl: el })

    // Desactivar el zombie sin soltarlo ruidosamente (removeAttribute+load
    // dispara error event en algunos browsers: ya no tiene listeners).
    try {
      old.pause()
      old.removeAttribute('src')
      old.load()
    } catch {
      /* noop */
    }

    if (src && get()._engine === 'audio') {
      el.src = src
      // currentTime solo es asignable con metadata cargada; un one-shot acá.
      const seekBack = () => {
        try {
          el.currentTime = resumeAt
        } catch {
          /* noop */
        }
      }
      el.addEventListener('loadedmetadata', seekBack, { once: true })
      el.load()
    }
  },

  registerYouTubeController: (controller) => {
    set({ ytController: controller })
    // Si había una canción esperando al IFrame (primera carga de la app,
    // o cambio de tema antes de que el controller estuviera listo),
    // arrancamos el video DIRECTO en este controller recién registrado —
    // nunca repetimos _loadCurrentAndPlay() completo, porque eso volvía a
    // disparar resolveCachedAudio()/POST /api/ytcache por segunda vez
    // para la misma canción (se veía en los logs como pares de requests
    // idénticos al mismo milisegundo).
    const { _engine, queue, currentIndex, volume, currentTime } = get()
    const song = queue[currentIndex]
    if (_engine === 'youtube' && song) {
      const videoId = String(song.videoId || song.id)
      controller.setVolume(volume)
      controller.load(videoId, currentTime || 0)
    }
  },

  currentSong: () => {
    const { queue, currentIndex } = get()
    return queue[currentIndex] || null
  },

  // Replace the queue and start playing at the specified index.
  playQueueAt: async (songs, index) => {
    // Nueva cola => la bolsa de shuffle vieja ya no aplica (índices distintos).
    set({ queue: songs, currentIndex: index, currentTime: 0, duration: 0, _shuffleBag: [], _trackStartReason: 'play' })
    await get()._loadCurrentAndPlay()
    // Smart Shuffle es una preferencia que persiste entre colas (como el
    // shuffle normal) — si ya estaba activo, la cola nueva también se
    // extiende con recomendaciones en vez de quedarse con las de la cola
    // anterior.
    if (get().smartShuffle && songs.length >= SMART_SHUFFLE_MIN_QUEUE && !get()._buildingSmartShuffle) {
      set({ _buildingSmartShuffle: true })
      buildSmartShuffleQueue(songs)
        .then((extended) => {
          if (!get().smartShuffle) return
          if (extended.length > get().queue.length) {
            set({ queue: extended, _shuffleBag: [] })
          }
        })
        .catch(() => {})
        .finally(() => set({ _buildingSmartShuffle: false }))
    }
  },

  /**
   * Arranca reproducción a partir de UNA canción puntual que el usuario
   * eligió de una búsqueda (o de "Descubre") — en vez de dejar el resto
   * de los resultados de esa búsqueda como cola, como hacía antes.
   *
   * Antes: buscabas "Andrea", le dabas play a la de Bad Bunny, y lo
   * "siguiente" en la cola eran más resultados que matchean el TEXTO
   * "Andrea" (de otros artistas, covers, etc.) — porque la cola era
   * literalmente el array de resultados de búsqueda. Ahora: la cola
   * arranca solo con esa canción y se completa con una "radio" armada
   * a partir del ARTISTA que realmente elegiste escuchar (mismo patrón
   * que "Porque te gusta X" en el home) — así el siguiente tema tiene
   * sentido musicalmente en vez de ser un accidente de coincidencia de
   * texto en el buscador.
   *
   * `searchResults` es opcional: si la canción vino de una lista donde
   * había más temas del MISMO artista, esos se aprovechan gratis (sin
   * pedir nada a la API) antes de ir a buscar más.
   */
  playSongRadio: async (song, searchResults = []) => {
    set({ queue: [song], currentIndex: 0, currentTime: 0, duration: 0, _shuffleBag: [], _trackStartReason: 'radio' })
    await get()._loadCurrentAndPlay()
    get()._extendRadioFromArtist(song, searchResults)
  },

  // Arma la "radio" del artista de `seedSong` y la agrega al final de la
  // cola sin interrumpir lo que ya está sonando (misma idea que
  // _extendQueueForAutoplay, pero disparada al toque en vez de esperar a
  // que la cola casi termine).
  _extendRadioFromArtist: async (seedSong, contextList = []) => {
    const artistName = seedSong?.artists?.[0]?.name || seedSong?.artist
    if (!artistName) return
    const artistKey = artistName.toLowerCase().trim()

    const knownSongs = [seedSong, ...get().queue]
    const knownIds = new Set(knownSongs.map((s) => String(s.id)))
    // Gratis: otras canciones del mismo artista que ya vinieron en la
    // búsqueda original, sin pedir nada más a la API.
    const fromContext = (contextList || []).filter((s) => {
      if (knownIds.has(String(s.id))) return false
      const name = (s?.artists?.[0]?.name || s?.artist || '').toLowerCase().trim()
      return name === artistKey
    })
    knownSongs.push(...fromContext)

    let extension = dedupeSongs(fromContext)
    if (extension.length < 6) {
      const more = await getTopArtistRecommendations(artistName, knownSongs, 12).catch(() => [])
      extension = dedupeSongs([...extension, ...more])
    }
    // Si el usuario ya se movió a otra canción (saltó varias veces rápido)
    // mientras esto resolvía, no tiene sentido pegarle esta cola vieja.
    if (extension.length > 0 && get().queue.some((s) => isSameSong(s, seedSong))) {
      set((s) => ({ queue: [...s.queue, ...extension] }))
    }
  },

  _loadCurrentAndPlay: async () => {
    const { audioEl, ytController, queue, currentIndex, _blobUrl } = get()
    const song = queue[currentIndex]
    if (!song) return

    // Flush metrics for the previous track before replacing it.
    // get()._flushMetrics() is called by the navigator methods now (next, prev, ended) 
    // to pass the correct end reason, but we leave a catch-all just in case.

    // Use a token to discard stale loads if the user skips quickly.
    const token = get()._loadToken + 1
    set({ _loadToken: token, currentTime: 0, _autoplayBlockedFor: null, _trackStartTime: Date.now(), _trackListenedMs: 0 })

    // Cortar el motor anterior ACÁ, sincrónico y antes de cualquier `await`
    // de esta función — sin importar qué ruta tome la pista nueva (YouTube
    // o audio externo/local).
    //
    // Bug que esto arregla: al saltar una canción, la pista vieja seguía
    // sonando durante todo lo que tardara en resolver la nueva (fetch de
    // caché, IndexedDB, lo que sea) porque el pause() solo pasaba DENTRO de
    // la rama de YouTube — la ruta de audio externo nunca cortaba nada antes
    // de sus propios `await`. Resultado audible: saltabas un tema que no te
    // gustaba, y durante ese hueco asincrónico seguía sonando ESE MISMO
    // tema (a veces hasta que terminaba de resolver la selección siguiente),
    // como si el skip no hubiera hecho nada. Cortar acá, antes de que
    // arranque cualquier ruta, hace que un skip sea silencio inmediato y
    // después la nueva pista — nunca el eco de la que acabás de abandonar.
    if (audioEl) {
      audioEl.pause()
      audioEl.removeAttribute('src')
    }
    if (ytController) ytController.stop()

    // Cleanup any previous blob URLs.
    if (_blobUrl) {
      URL.revokeObjectURL(_blobUrl)
      set({ _blobUrl: null })
    }

    trackRecentlyPlayed(song)

    // Trigger background autoplay extension when nearing the end of the queue.
    {
      const { queue: q, currentIndex: ci, isShuffle } = get()
      if (get().autoplayEnabled && !isShuffle && ci >= q.length - 2 && q.length > 1) {
        get()._extendQueueForAutoplay()
      }
    }

    // --- YouTube Route: Blob CDN primero, IFrame instantáneo como arranque ---
    //   1. Si ya está extraída en el Blob CDN: audio directo desde el CDN de
    //      Vercel, arranque rápido Y listo para segundo plano.
    //   2. Si no: streamea por IFrame INMEDIATO (cero espera) y en paralelo
    //      el server extrae + sube en background (/api/ytcache). Cuando el
    //      upload aparece en el CDN, se notifica con un toast — a partir de
    //      ahí toda reproducción futura de esta canción es ruta Blob.
    // Una sola extracción por canción sirve para todos los usuarios/sesiones.
    if (isYouTubeSong(song)) {
      const videoId = String(song.videoId || song.id)

      get()._hydrateCurrentSong(song)
      set({ isBuffering: true })

      // 1) ¿Ya hay audio real listo para esta canción? Chequea el videoId
      // exacto Y (si esta canción ya fue cacheada por CUALQUIER otro
      // usuario bajo un videoId distinto) el alias por título+artista —
      // ambos son fetches directos al CDN del Blob, sin pasar por la
      // función serverless, así que no hay espera de cold start. Esto es
      // lo que hace que el Usuario B reciba el audio real de una cuando
      // el Usuario A ya la dejó cacheada, sin pasar por el IFrame.
      const resolved = await resolveCachedAudio(videoId, { title: song.title, artist: primaryArtistName(song) })
      if (get()._loadToken !== token) return

      if (resolved?.url && audioEl) {
        set({
          _engine: 'audio',
          _ytFallbackStage: 'blob',
          isPlaying: true,
          isBuffering: true,
          duration: song.duration || 0,
          // Fuente real para el alineador de letras (ver LyricsPanel).
          _activeAudio: { songId: String(song.id), videoId, url: resolved.url },
        })
        audioEl.src = resolved.url
        audioEl.load()
        try {
          await audioEl.play()
          if (get()._loadToken === token) set({ isPlaying: true })
        } catch (e) {
          if (e instanceof Error && e.name !== 'NotAllowedError' && e.name !== 'AbortError') {
            console.warn('Error de reproducción:', e)
          }
          if (e instanceof Error && e.name === 'NotAllowedError') get()._armAutoplayRetry(song)
          set({ isPlaying: false })
        }

        get()._prefetchNext()
        return
      }

      // 2) Sin blob aún: IFrame Player INMEDIATO (cero espera) + job de
      // extracción server-side en background.
      get()._playViaIframe(song)

      // Disparar extracción server-side. Mandamos título+artista para que
      // el server pueda reusar el audio si ESTA canción ya está cacheada
      // bajo otro videoId (frecuente en YT Music) en vez de re-extraer.
      const isStale = () => {
        const s = get()
        if (s._loadToken !== token) return true
        const current = s.queue[s.currentIndex]
        return !current || String(current.videoId || current.id) !== videoId
      }

      requestCache(videoId, { title: song.title, artist: primaryArtistName(song) })
        .then(async (result) => {
          if (isStale()) return
          const readyVideoId = result?.videoId || videoId
          if (result?.status === 'ready') {
            // Ya estaba (exacto, o la misma canción bajo otro videoId ya
            // cacheado) — no hace falta esperar polling, pasamos directo.
            const url = await getCachedAudioUrl(readyVideoId)
            if (url && !isStale()) get()._switchYtEngineToAudio(song, url, token)
            return
          }
          // La cadena entera de YouTube (youtubei.js → muxed → Piped
          // server-side, ver ytcore.ts) ya se dio por vencida para esta
          // pista — ni sentido tiene esperar polling que nunca va a
          // encontrar un blob. Vamos directo a probar otra fuente.
          if (result?.status === 'error' || result?.status === 'unconfigured') {
            get()._tryCrossSourceFallback(song, token)
            return
          }
          // Procesando: polling sobre el videoId que realmente va a
          // recibir el archivo (normalmente el mismo que se pidió).
          watchCacheReady(readyVideoId, {
            isStale,
            onReady: (url: string) => {
              if (!isStale()) get()._switchYtEngineToAudio(song, url, token)
            },
            onExhausted: () => {
              if (!isStale()) get()._tryCrossSourceFallback(song, token)
            },
          })
        })
        .catch(() => {
          if (!isStale()) get()._tryCrossSourceFallback(song, token)
        })

      get()._prefetchNext()
      return
    }

    // --- Audio Route: pistas del catálogo local o externas ---
    if (ytController) ytController.stop()

    set({ _engine: 'audio' })

    if (!audioEl) return

    let src = song.audioSrc || song.streamUrl || null
    if (!src) {
      console.warn('[XFY] Sin URL de audio — saltando pista')
      if (queue.length > 1) await get().next()
      else set({ isPlaying: false, isBuffering: false })
      return
    }

    // Pistas externas: mismo patrón "caché local → stream directo + cachear
    // por detrás" que ya usa la ruta de YouTube más arriba. Antes esto
    // esperaba a `enqueueDownload` completar el archivo ENTERO (descarga +
    // blob) antes de siquiera setear audio.src — el usuario tocaba play y
    // no pasaba nada hasta que la canción entera bajara. Ahora, si no está
    // cacheada, se streamea la URL remota tal cual (el navegador arranca
    // por Range requests) y la descarga completa entra en background.
    if (song.isExternal && /^https?:\/\//.test(src)) {
      const cacheKey = `xfy-track-${song.id}`
      set({ isBuffering: true })
      let cachedSrc: string | null = null
      try {
        cachedSrc = await getCachedAssetIfPresent(cacheKey)
      } catch {
        cachedSrc = null
      }
      if (get()._loadToken !== token) return
      if (cachedSrc) {
        src = cachedSrc
        set({ isBuffering: false, _blobUrl: cachedSrc })
      } else {
        // Fire-and-forget: no bloquea el play, solo deja el archivo listo
        // en caché para la próxima vez.
        enqueueDownload({ key: cacheKey, url: src, kind: 'audio', priority: 'now' }).catch(() => {})
        set({ isBuffering: false, _blobUrl: null })
      }
    }

    if (get()._loadToken !== token) return

    audioEl.src = src
    audioEl.load()
    // Fuente real para el alineador de letras (pistas externas/locales).
    set({
      _activeAudio: {
        songId: String(song.id),
        videoId: song.videoId ? String(song.videoId) : null,
        url: src,
      },
    })
    try {
      await audioEl.play()
      if (get()._loadToken === token) set({ isPlaying: true })
    } catch (e) {
      if (e instanceof Error && e.name !== 'NotAllowedError' && e.name !== 'AbortError') {
        console.warn('Error de reproducción:', e)
      }
      set({ isPlaying: false })
    }

    get()._prefetchNext()
  },

  // Reproduce la pista actual por el IFrame Player API. Último eslabón de
  // la cadena de YouTube: se usa solo cuando no hubo extracción de audio
  // o la cadena directa → proxy ya falló. `resumeAt` retoma en ese punto
  // exacto en vez de arrancar de cero (recuperación a mitad de canción).
  _playViaIframe: (song, resumeAt = 0) => {
    const { audioEl, ytController } = get()
    const videoId = String(song.videoId || song.id)

    if (audioEl) {
      audioEl.pause()
      audioEl.removeAttribute('src')
    }

    set({
      _ytFallbackStage: 'iframe',
      _engine: 'youtube',
      isPlaying: true,
      isBuffering: !ytController,
      duration: song.duration || 0,
      currentTime: resumeAt,
    })
    if (ytController) {
      ytController.setVolume(get().volume)
      ytController.load(videoId, resumeAt)
    }
    // Si ytController todavía no está registrado (primera carga de la
    // app), registerYouTubeController() vuelve a disparar la carga en
    // cuanto esté listo.

    // Watchdog: si a los 9s seguimos en 'iframe' sin haber arrancado a
    // sonar (mismo videoId, mismo isBuffering), algo se colgó — script del
    // IFrame API que nunca cargó, video sin permiso de embed que no
    // disparó onError, autoplay bloqueado en silencio, etc. Antes esto se
    // quedaba como el chip "Preparando audio…" pegado para siempre; ahora
    // se salta la pista con un aviso en vez de dejar al usuario mirando
    // un spinner que no va a ningún lado.
    const watchdogToken = get()._loadToken
    setTimeout(() => {
      const s = get()
      if (s._loadToken !== watchdogToken) return
      if (s._ytFallbackStage !== 'iframe' || s._engine !== 'youtube') return
      if (!s.isBuffering) return
      console.warn('[XFY] IFrame de YouTube no arrancó a tiempo — saltando pista')
      toast.error('No se pudo reproducir esa canción', {
        description: 'YouTube tardó demasiado en responder. Probá con otra.',
      })
      s.setBuffering(false)
      s.handleTrackError()
    }, 9000)
  },

  /**
   * Recuperación cuando el <audio> falla con una pista de YouTube:
   * blob (CDN) → IFrame Player. Devuelve true si este caller se hizo cargo del
   * error (AudioEngine NO debe saltar de canción); false si la pista que
   * falló no era de YouTube por audio y sigue handleTrackError normal.
   */
  _attemptYtAudioRecovery: async (failedSrc) => {
    const { queue, currentIndex, audioEl } = get()
    const song = queue[currentIndex]
    if (!song || !isYouTubeSong(song)) return false
    if (!audioEl || audioEl.src !== failedSrc) return false

    const stage = get()._ytFallbackStage

    // Solo teníamos dos etapas: 'blob' (CDN) → 'iframe'
    if (stage === 'blob') {
      console.warn('[XFY] Blob CDN falló — cayendo al IFrame')
      // Retomamos donde se había quedado (currentTime ya venía siendo
      // trackeado por el <audio> mientras sonaba como blob) en vez de
      // reiniciar la canción desde cero.
      get()._playViaIframe(song, get().currentTime || 0)
      return true
    }

    return false
  },

  /**
   * Sube de categoría una pista que arrancó por IFrame en cuanto el blob
   * del CDN queda listo — incluso a mitad de reproducción. Precarga el
   * <audio> real EN PARALELO mientras el IFrame sigue sonando, lo alinea
   * en el mismo punto exacto y recién ahí corta el IFrame: el objetivo es
   * que quien está escuchando no note el cambio de motor (ni un corte, ni
   * un salto de posición, ni un salto visual).
   */
  _switchYtEngineToAudio: async (song, url, token) => {
    const { audioEl, ytController } = get()
    if (!audioEl || !ytController) return
    // Si para cuando esto corre ya cambiamos de pista, o esta pista ya no
    // está sonando por IFrame (ya se cayó a audio antes, o el usuario
    // saltó), no hay nada que hacer.
    if (get()._loadToken !== token || get()._engine !== 'youtube') return

    const resumeAt = ytController.getCurrentTime?.() || get().currentTime || 0

    // Importante: fijar currentTime DESPUÉS de load() — load() lo resetea
    // a 0, así que hacerlo antes se pierde y la canción "saltaría" al
    // principio al pasar a audio real.
    audioEl.src = url
    audioEl.load()
    audioEl.currentTime = resumeAt

    // Esperamos a que el <audio> esté listo para reproducir sin cortes.
    // Mientras tanto el IFrame sigue siendo la fuente de sonido real —
    // nada se corta si esto tarda o falla.
    const ready = await new Promise<boolean>((resolve) => {
      let settled = false
      const finish = (ok: boolean) => {
        if (settled) return
        settled = true
        audioEl.removeEventListener('canplay', onCanPlay)
        audioEl.removeEventListener('error', onError)
        resolve(ok)
      }
      const onCanPlay = () => finish(true)
      const onError = () => finish(false)
      audioEl.addEventListener('canplay', onCanPlay, { once: true })
      audioEl.addEventListener('error', onError, { once: true })
      // Si el navegador no dispara ninguno de los dos eventos por lo que
      // sea, no nos quedamos esperando para siempre.
      setTimeout(() => finish(false), 8000)
    })

    // Puede haber pasado cualquier cosa mientras esperábamos: cambio de
    // canción, el usuario pausó, o ya se resolvió por otro camino.
    if (get()._loadToken !== token || get()._engine !== 'youtube') return
    if (!ready) return // seguimos por IFrame; se reintentará en el próximo watchCacheReady si hiciera falta

    try {
      audioEl.currentTime = ytController.getCurrentTime?.() || resumeAt
    } catch {
      /* noop */
    }

    const stillPlaying = get().isPlaying
    if (stillPlaying) {
      try {
        await audioEl.play()
      } catch (e) {
        const blocked = e instanceof Error && e.name === 'NotAllowedError'
        if (!blocked && e instanceof Error && e.name !== 'AbortError') {
          console.warn('[XFY] No se pudo pasar de IFrame a audio real')
        }
        // Bloqueo de autoplay (típico: el blob quedó listo con la app ya en
        // segundo plano y algunos navegadores exigen gesto nuevo para ese
        // src): nos quedamos en el IFrame que sigue sonando, pero ARMAMOS
        // el retry al primer toque — así, al volver, el usuario cae directo
        // al audio real (bloqueo-proof) en vez de un IFrame que puede morir.
        if (blocked) get()._armAutoplayRetry(song)
        return
      }
    }

    if (get()._loadToken !== token || get()._engine !== 'youtube') {
      // Cambió el contexto mientras esperábamos el play() — no tocar el IFrame.
      return
    }

    // Recién acá, con el audio real ya sonando en el mismo punto, soltamos
    // el IFrame — el corte queda inaudible.
    ytController.stop()
    set({
      _engine: 'audio',
      _ytFallbackStage: 'blob',
      isBuffering: false,
      isPlaying: stillPlaying,
      // A partir de acá el alineador puede pedir la alineación contra el
      // archivo exacto del CDN (antes no había URL de audio para esta pista).
      _activeAudio: { songId: String(song.id), videoId: String(song.videoId || song.id), url },
    })
    // Aviso de upgrade IFrame → blob. Toast si el usuario está mirando;
    // NOTIFICACIÓN DEL SISTEMA si está en segundo plano (que es justo el
    // caso que le importa: "ya podés bloquear el teléfono"). Solo-when-hidden
    // evita duplicar toast + notificación en pantalla.
    const readySong = song
    showAppNotification(
      {
        title: 'Listo para segundo plano',
        body: `"${readySong.title}" ya suena desde el caché compartido.`,
        tag: `xfy-blob-ready-${readySong.id}`,
        image: readySong.albumArtUrl || undefined,
      },
      { onlyWhenHidden: true },
    )
      .catch(() => false)
      .then((notified) => {
        // Si ya se mostró la notificación del sistema (app oculta), el toast
        // sobra: el usuario la va a ver igual al volver, duplicada.
        if (!notified && get()._loadToken === token) {
          toast('Listo para segundo plano', {
            description: `"${song.title}" ya suena desde el caché compartido — podés bloquear el teléfono o cambiar de app sin cortar la música.`,
          })
        }
      })
  },

  /**
   * Último recurso cuando TODA la cadena propia de YouTube falló (server
   * sin extraer + Piped/Invidious server-side también sin resultado, ver
   * ytcore.ts) y seguimos sonando por el IFrame — que YouTube pausa solo
   * si la pestaña/PWA pasa a segundo plano o el celular se bloquea. En
   * vez de quedarnos ahí indefinidamente, buscamos la MISMA canción en
   * cualquier otra fuente registrada (Piped como frontend propio, Audius,
   * o lo que se agregue después) y si hay match confiable (fuzzy match,
   * no el primer resultado a ciegas) saltamos al audio real con el mismo
   * cross-fade sin cortes que usa _switchYtEngineToAudio.
   */
  _tryCrossSourceFallback: async (song, token) => {
    if (get()._loadToken !== token || get()._engine !== 'youtube') return
    const alt = await findAlternateStream(song, 'ytmusic')
    if (!alt || get()._loadToken !== token || get()._engine !== 'youtube') return
    console.info(`[XFY] YouTube agotado — reproduciendo vía ${alt.sourceName}`)
    await get()._switchYtEngineToAudio(song, alt.url, token)
  },

  /**
   * iOS Safari bloquea audioEl.play() si no ocurre dentro del gesto del
   * usuario — y nuestras rutas de YouTube tienen awaits intermedios
   * (resolver URL, matchear caché) que rompen la cadena del gesto. Cuando
   * eso pasa: armamos UN listener global que, al primer toque en cualquier
   * lado de la app, reanuda exactamente la pista que quedó bloqueada.
   */
  _armAutoplayRetry: (song) => {
    if (!song || get()._autoplayBlockedFor === String(song.id)) return

    // Si había un listener armado para una pista bloqueada anterior (el
    // usuario saltó de canción sin llegar a tocar la pantalla), lo sacamos
    // primero — si no, se van apilando uno por cada canción bloqueada.
    get()._autoplayRetryCleanup?.()

    set({ _autoplayBlockedFor: String(song.id) })

    const retry = () => {
      set({ _autoplayRetryCleanup: null })
      void get()._retryBlockedAutoplay()
    }
    document.addEventListener('pointerdown', retry, { once: true })
    set({ _autoplayRetryCleanup: () => document.removeEventListener('pointerdown', retry) })
  },

  /**
   * Reintenta la pista bloqueada por NotAllowedError sin depender de un
   * 'pointerdown'. Necesario porque un desbloqueo por Face ID/huella o el
   * cambio de foco de la app NO deja un toque real en el documento —
   * MediaSessionSync la llama en 'visibilitychange' para cubrir ese caso.
   * Devuelve true si logró reanudar.
   */
  _retryBlockedAutoplay: async () => {
    const s = get()
    const blockedId = s._autoplayBlockedFor
    if (!blockedId || s.isPlaying) return false
    const song = s.queue[s.currentIndex]
    if (!song || String(song.id) !== blockedId) {
      set({ _autoplayBlockedFor: null })
      return false
    }

    if (s._engine === 'youtube') {
      try {
        s.ytController?.play?.()
        set({ isPlaying: true, _autoplayBlockedFor: null })
        return true
      } catch {
        return false
      }
    }

    const el = s.audioEl
    if (!el || !el.src || el.error) {
      set({ _autoplayBlockedFor: null })
      return false
    }
    try {
      await el.play()
      set({ isPlaying: true, _autoplayBlockedFor: null })
      return true
    } catch {
      return false
    }
  },

  _hydrateCurrentSong: async (song) => {
    try {
      const songId = song.videoId || song.id
      if (typeof songId !== 'string' || !songId) return
      let full: Song | null = await getSong(songId).catch((e: unknown) => {
        console.warn('[XFY] getSong (YT Music) falló')
        return null
      })

      // Si YouTube Music falla (ej. IP de Vercel bloqueada en getSong) o devuelve lo mismo,
      // usamos Apple/iTunes como fallback para obtener los colaboradores reales — a través
      // del gateway compartido (appleClient), así esta llamada respeta la misma cola,
      // el mismo caché y el mismo circuit breaker que las portadas y no compite por su cuenta.
      if (!full || !full.artist || full.artist === song.artist) {
        const artistName = await lookupArtistName(song.title ?? '', song.artist ?? '').catch(() => {
          console.warn('[XFY] lookupArtistName (Apple/iTunes) falló')
          return null
        })
        if (artistName) {
          full = { ...(full || song), artist: artistName } as Song
        } else if (!full) {
          console.warn('[XFY] No se pudo enriquecer el artista — se mantiene el nombre original')
        }
      }

      if (full && full.artist) {
        const { queue, currentIndex } = get()
        if (queue[currentIndex]?.id === song.id) {
          // Si quien resolvió el artista fue el fallback de Apple, `full` solo trae el
          // string `artist` (p. ej. "Bad Bunny & The Marías") — nunca un array `artists`
          // propio con cada colaborador por separado. Antes, en ese caso nos quedábamos
          // con el `song.artists` original (armado con el nombre incompleto, "Bad Bunny"
          // solo), y como ArtistLinks/resolveArtistEntries prioriza el array sobre el
          // string cuando existe, el reproductor principal seguía mostrando solo el
          // artista viejo aunque `artist` ya estuviera corregido — mientras que el mini
          // player, que lee directamente el string, sí mostraba el nombre completo.
          // Reconstruimos el array a partir del nombre nuevo cuando la fuente no trajo
          // uno propio, para que ambos queden consistentes en todas las pantallas.
          const artists = full.artists && full.artists.length > 0
            ? full.artists
            : full.artist !== song.artist
              ? splitArtistNames(full.artist).map((name: string, i: number) => ({
                  name,
                  artistId: i === 0 ? (song.artistId || null) : null,
                }))
              : song.artists

          const updated: PlayerSong = {
            ...song,
            artist: full.artist,
            artists,
            albumArtUrl: full.albumArtUrl || song.albumArtUrl,
            duration: full.duration || song.duration,
          }
          if (updated.artist !== song.artist) {
            const newQueue = [...queue]
            newQueue[currentIndex] = updated
            set({ queue: newQueue })

            // Actualizar historial reciente para que se vea el nombre completo
            trackRecentlyPlayed(updated)
          }
        }
      }
    } catch (e) {
      console.warn('[XFY] _hydrateCurrentSong falló inesperadamente')
    }
  },

  // Fetch related tracks and append them to the queue without altering current playback.
  _extendQueueForAutoplay: async () => {
    const { autoplayEnabled } = get()
    if (!autoplayEnabled) return
    if (autoplayExtensionPromise) {
      await autoplayExtensionPromise
      return
    }

    const { queue } = get()
    set({ _extendingAutoplay: true })
    autoplayExtensionPromise = getAutoplayExtension(queue, queue)
      .then((extension) => {
        if (extension.length > 0) {
          set((s) => ({ queue: [...s.queue, ...extension] }))
        }
      })
      .catch((e: unknown) => {
        console.warn('[XFY] No se pudo extender la cola con reproducción inteligente')
      })
      .finally(() => {
        set({ _extendingAutoplay: false })
        autoplayExtensionPromise = null
      })
    await autoplayExtensionPromise
  },

  setAutoplayEnabled: (enabled) => {
    try {
      localStorage.setItem(AUTOPLAY_KEY, String(enabled))
    } catch {
      // Ignore if localStorage is unavailable.
    }
    set({ autoplayEnabled: enabled })
  },

  // El visualizador de audio se removió por completo (ver limpieza de
  // localStorage al final de este archivo, cerca de wireAudioElement).

  // Prefetch estilo Spotify: mientras suena la pista actual, las próximas
  // de la cola entran al caché completo (prioridad 'next') para que skip/
  // next sean instantáneos y sobrevivan offline. Las externas no-YouTube
  // conservan su prefetch propio; las de YouTube van por smartCache.
  _prefetchNext: () => {
    const { queue, currentIndex, isShuffle } = get()
    if (queue.length < 2 || isShuffle) return

    const nextSong = queue[(currentIndex + 1) % queue.length]
    if (nextSong && !isYouTubeSong(nextSong)) {
      if (nextSong.isExternal && /^https?:\/\//.test(nextSong.audioSrc || '')) {
        prefetch({ key: `xfy-track-${nextSong.id}`, url: nextSong.audioSrc as string, kind: 'audio' })
      }
    }

    prefetchQueueAhead(queue as PlayerSong[], currentIndex).catch(() => {})
  },

  play: async () => {
    const { _engine, ytController, audioEl, queue, currentIndex } = get()
    if (currentIndex === -1 || queue.length === 0) return
    if (_engine === 'youtube') {
      ytController?.play()
      set({ isPlaying: true })
      return
    }

    if (!audioEl) return
    try {
      await audioEl.play()
      set({ isPlaying: true })
    } catch (e) {
      if (e instanceof Error && e.name !== 'NotAllowedError' && e.name !== 'AbortError') {
        console.warn('Error de reproducción:', e)
      }
    }
  },

  pause: () => {
    const { _engine, ytController, audioEl } = get()
    if (_engine === 'youtube') ytController?.pause()
    else audioEl?.pause()
    set({ isPlaying: false })
    get()._flushMetrics()
  },

  toggle: () => {
    if (get().isPlaying) get().pause()
    else get().play()
  },

  next: async () => {
    const { queue, currentIndex, isShuffle, _shuffleBag, currentTime, duration } = get()
    if (queue.length === 0) return
    
    // Determine skip type for metrics
    let endReason: import('@shared/lib/metrics').EndReason = 'skip_early'
    if (duration > 0) {
      const pct = (currentTime / duration) * 100
      if (pct > 80) endReason = 'skip_late'
      else if (pct > 20) endReason = 'skip_mid'
    } else if (currentTime > 30) {
      endReason = 'skip_mid'
    }
    
    get()._flushMetrics(endReason)
    
    let nextIndex: number
    if (isShuffle && queue.length > 1) {
      // Aleatorio inteligente: cada canción de la cola suena una vez antes
      // de repetirse, en vez del Math.random() puro de antes (que podía
      // volver a tocar el mismo tema seguidas veces).
      const result = takeNextFromShuffleBag(queue, currentIndex, _shuffleBag)
      nextIndex = result.nextIndex
      set({ _shuffleBag: result.bag })
    } else {
      nextIndex = (currentIndex + 1) % queue.length
    }
    set({ currentIndex: nextIndex, currentTime: 0, duration: 0, _trackStartReason: 'next' })
    await get()._loadCurrentAndPlay()
  },

  previous: async () => {
    const { queue, currentIndex, _engine, ytController, audioEl } = get()
    if (queue.length === 0) return
    // Restart the current track if it has played past 3 seconds; otherwise go to the previous track.
    const t = _engine === 'youtube' ? (ytController?.getCurrentTime?.() || 0) : (audioEl?.currentTime || 0)

    if (t > 3) {
      if (_engine === 'youtube') ytController?.seek(0)
      else if (audioEl) audioEl.currentTime = 0
      set({ currentTime: 0 })
      return
    }
    
    get()._flushMetrics('skip_early')
    
    const prevIndex = (currentIndex - 1 + queue.length) % queue.length
    set({ currentIndex: prevIndex, currentTime: 0, duration: 0, _trackStartReason: 'prev' })
    await get()._loadCurrentAndPlay()
  },

  handleEnded: async () => {
    const { repeatMode, _engine, ytController, audioEl } = get()
    
    get()._flushMetrics('ended')
    
    if (repeatMode === 1) {
      if (_engine === 'youtube') {
        ytController?.seek(0)
        ytController?.play()
      } else if (audioEl) {
        audioEl.currentTime = 0
        await get().play()
      }
      return
    }
    const { queue, currentIndex } = get()
    const isLast = currentIndex === queue.length - 1
    if (isLast && repeatMode === 0) {
      const { autoplayEnabled, isShuffle } = get()
      if (autoplayEnabled && !isShuffle) {
        await get()._extendQueueForAutoplay()
        const stillLast = get().currentIndex === get().queue.length - 1
        if (!stillLast) {
          set({ _trackStartReason: 'autoplay' })
          await get().next()
          return
        }
      }
      set({ isPlaying: false })
      return
    }
    set({ _trackStartReason: 'next' })
    await get().next()
  },

  // Skip to the next track if the current one fails to load/play.
  handleTrackError: async () => {
    const { queue, _consecutiveErrors } = get()
    const streak = _consecutiveErrors + 1
    set({ _consecutiveErrors: streak })

    if (streak >= MAX_CONSECUTIVE_ERRORS) {
      get()._flushMetrics('error')
      set({ isPlaying: false, isBuffering: false, _consecutiveErrors: 0 })
      toast.error('Varias canciones seguidas no se pudieron reproducir', {
        description: 'Puede que sus archivos de audio no estén disponibles. Probá con otra canción.',
      })
      return
    }

    get()._flushMetrics('error')
    
    if (queue.length > 1) {
      set({ _trackStartReason: 'next' })
      await get().next()
    }
    else set({ isPlaying: false, isBuffering: false })
  },
  // Reset the error streak upon successful playback.
  _resetErrorStreak: () => {
    if (get()._consecutiveErrors !== 0) set({ _consecutiveErrors: 0 })
  },
  // Alias for backward compatibility.
  handleYouTubeError: async () => get().handleTrackError(),

  seek: (time) => {
    const { _engine, ytController, audioEl } = get()
    if (_engine === 'youtube') ytController?.seek(time)
    else if (audioEl) audioEl.currentTime = time
    set({ currentTime: time })
  },

  // Track actual playback progress by evaluating the delta between currentTime ticks.
  _trackProgress: (t) => {
    const state = get()
    if (!state.isPlaying) return
    const song = state.queue[state.currentIndex]
    if (!song) return

    const delta = t - state._lastTickTime
    if (delta <= 0 || delta > 2.5) return

    updateScrobbleProgress(song as PlayerSong, delta * 1000)

    const deltaMs = delta * 1000
    const nextMs = state._listenedMs + deltaMs
    const trackListenedMs = state._trackListenedMs + deltaMs

    if (nextMs >= FLUSH_INTERVAL_MS) {
      // Heartbeat: only tops up totalMs/days so a tab close doesn't lose
      // "listened today" data. Per-song/artist aggregates (which need the
      // full track completion%, not a 15s slice of it) are committed once
      // per real listen segment by _flushMetrics(), not here.
      recordPlaytime(nextMs)
      set({ _listenedMs: 0, _trackListenedMs: trackListenedMs, _metricsSong: song })
    } else {
      set({ _listenedMs: nextMs, _trackListenedMs: trackListenedMs, _metricsSong: song })
    }
  },

  _flushMetrics: (endReason?: import('@shared/lib/metrics').EndReason) => {
    const { _listenedMs, _trackListenedMs, _metricsSong, duration, isShuffle, smartShuffle, _trackStartReason } = get()

    // Top up any unflushed heartbeat buffer first so totalMs/days stays accurate.
    if (_listenedMs > 0) recordPlaytime(_listenedMs)

    if (_metricsSong && _trackListenedMs > 0) {
      const completionPct = duration > 0 ? Math.min(100, Math.round((_trackListenedMs / (duration * 1000)) * 100)) : undefined

      let context: import('@shared/lib/metrics').PlayContext = 'playlist'
      if (smartShuffle) context = 'smart_shuffle'
      else if (isShuffle) context = 'shuffle'

      recordListen({
        song: _metricsSong as PlayerSong,
        ms: _trackListenedMs,
        duration: duration ? duration * 1000 : undefined,
        completionPct,
        startReason: _trackStartReason || 'play',
        endReason: endReason || 'pause',
        context,
        skipGlobalTotals: true, // already accounted for via recordPlaytime() heartbeats above
      })
    }
    set({ _listenedMs: 0, _trackListenedMs: 0, _metricsSong: null })
  },

  setCurrentTime: (t) => {
    get()._trackProgress(t)
    set({ currentTime: t, _lastTickTime: t })

    // SponsorBlock: si la pista actual entró a un segmento de sponsor/
    // self-promo/interacción, saltamos al final del segmento. Se hace acá
    // (no en un useEffect de componente) porque setCurrentTime ya corre en
    // cada tick de reproducción para ambos engines (audio nativo e
    // iframe), así que es el único punto que ve el tiempo real sin
    // duplicar wiring por engine.
    const song = get().queue[get().currentIndex]
    ensureSponsorSegmentsLoaded(song)
    if (sponsorSegmentsForId && song && (song.videoId || String(song.id)) === sponsorSegmentsForId) {
      const active = findActiveSegment(sponsorSegments, t)
      if (active) get().seek(active.endSec)
    }
  },
  setDuration: (d) => set({ duration: d }),
  setBuffering: (b) => set({ isBuffering: b }),
  // Called exclusively by YouTubeEngine to sync state.
  _setPlayingFromEngine: (playing) => set({ isPlaying: playing }),
  // Al activar shuffle se limpia la bolsa para que next() la arme de cero
  // a partir de la canción actual (así nunca repite lo que está sonando).
  toggleShuffle: () => set((s) => ({ isShuffle: !s.isShuffle, smartShuffle: false, _shuffleBag: [] })),
  cycleShuffleMode: () => {
    const { isShuffle, smartShuffle, _buildingSmartShuffle, queue } = get()

    // Off -> Shuffle normal.
    if (!isShuffle && !smartShuffle) {
      set({ isShuffle: true, smartShuffle: false, _shuffleBag: [] })
      return
    }

    // Shuffle normal -> Smart Shuffle. Si la cola es muy chica para que
    // tenga sentido (< SMART_SHUFFLE_MIN_QUEUE), Spotify tampoco lo
    // ofrece: se salta directo a "Off" en vez de activar algo que no va a
    // recomendar nada.
    if (isShuffle && !smartShuffle) {
      if (queue.length < SMART_SHUFFLE_MIN_QUEUE) {
        set({ isShuffle: false, smartShuffle: false, _shuffleBag: [] })
        return
      }
      if (_buildingSmartShuffle) return
      set({ smartShuffle: true, _buildingSmartShuffle: true })
      buildSmartShuffleQueue(queue)
        .then((extended) => {
          // Si el usuario ya desactivó Smart Shuffle mientras esto
          // resolvía, no pisar la cola con canciones recomendadas de una
          // sesión que ya no está activa.
          if (!get().smartShuffle) return
          if (extended.length > queue.length) {
            set({ queue: extended, _shuffleBag: [] })
            toast.success(`Smart Shuffle sumó ${extended.length - queue.length} canciones que pegan con la vibra ✨`)
          }
        })
        .catch(() => {
          // Silencioso: si el radio falla, Smart Shuffle simplemente se
          // comporta como shuffle normal (no rompe la reproducción).
        })
        .finally(() => set({ _buildingSmartShuffle: false }))
      return
    }

    // Smart Shuffle -> Off. Las canciones recomendadas ya mezcladas en la
    // cola se dejan como están (el usuario las puede seguir escuchando o
    // saltar); solo se apaga el modo para que no se sigan sumando más.
    set({ isShuffle: false, smartShuffle: false, _shuffleBag: [] })
  },
  cycleRepeat: () => set((s) => ({ repeatMode: ((s.repeatMode + 1) % 3) as 0 | 1 | 2 })),

  setVolume: (v) => {
    const { audioEl, ytController } = get()
    if (audioEl) audioEl.volume = v

    ytController?.setVolume(v)
    set({ volume: v })
  },

  getRecentlyPlayed: () => readRecent(),

  // Halt playback and clear the queue (e.g., on logout).
  reset: () => {
    const { audioEl, ytController, _blobUrl } = get()
    get()._flushMetrics()
    get()._autoplayRetryCleanup?.()
    if (audioEl) {
      audioEl.pause()
      audioEl.removeAttribute('src')
    }

    ytController?.stop()
    if (_blobUrl) URL.revokeObjectURL(_blobUrl)
    set({
      queue: [],
      currentIndex: -1,
      _shuffleBag: [],
      smartShuffle: false,
      _buildingSmartShuffle: false,
      isPlaying: false,
      currentTime: 0,
      duration: 0,
      _blobUrl: null,
      _engine: 'audio',
      isBuffering: false,
      _ytFallbackStage: null,
      _activeAudio: null,
      _autoplayBlockedFor: null,
      _autoplayRetryCleanup: null,
      _sessionStartTime: Date.now(),
      _trackStartReason: null,
      _trackStartTime: 0,
      _listenedMs: 0,
      _trackListenedMs: 0,
      _metricsSong: null,
    })
  },
}))

// ============================================================
// wireAudioElement — fábrica del elemento <audio> del player.
//
// VIVE EN EL STORE (y no en el componente AudioEngine) a propósito:
// el watchdog de segundo plano necesita poder RECREAR el elemento
// cuando WebKit lo deja zombie (iOS 26 PWA reopen, bug 295518) — y
// recrear implica re-atachar TODOS los handlers al nodo nuevo. Tener
// el wiring acá hace que AudioEngine sea solo "crea uno al montar" y
// que la recreación preserve exactamente la misma semántica de eventos.
// ============================================================
export function wireAudioElement(): HTMLAudioElement {
  const audio = new Audio()
  audio.preload = 'metadata'

  // Las canciones de YouTube suenan por acá cuando ya están en el Blob
  // CDN (ver ytblob / usePlayerStore); solo caen al IFrame mientras el
  // Blob no existe todavía o como último recurso de la cadena de
  // recuperación. Los eventos de este elemento solo afectan al estado
  // global cuando el motor activo es 'audio'.
  const isActive = () => usePlayerStore.getState()._engine === 'audio'

  audio.addEventListener('timeupdate', () => {
    if (!isActive()) return
    usePlayerStore.getState().setCurrentTime(audio.currentTime)
  })

  const applyReportedDuration = () => {
    if (!isActive()) return
    const reported = audio.duration
    const catalogDuration = usePlayerStore.getState().duration

    // audio.duration no es confiable en el contenedor audio-only/DASH que
    // sirve el blob de YouTube: a veces sale ~2x la duración real. Si ya
    // tenemos una duración de catálogo (YT Music/Apple, confiable) y el
    // navegador reporta algo muy por encima, nos quedamos con la del
    // catálogo en vez de pisarla.
    if (!Number.isFinite(reported) || reported <= 0) return
    if (catalogDuration > 0 && reported > catalogDuration * 1.4) return

    usePlayerStore.getState().setDuration(reported)
  }
  // Algunos streams/blobs reportan duration como Infinity en loadedmetadata
  // y recién resuelven después — 'durationchange' avisa cuando eso pasa.
  audio.addEventListener('loadedmetadata', applyReportedDuration)
  audio.addEventListener('durationchange', applyReportedDuration)

  audio.addEventListener('ended', () => {
    if (!isActive()) return
    void usePlayerStore.getState().handleEnded()
  })

  audio.addEventListener('waiting', () => {
    if (!isActive()) return
    usePlayerStore.getState().setBuffering(true)
  })
  audio.addEventListener('playing', () => {
    if (!isActive()) return
    usePlayerStore.getState().setBuffering(false)
    usePlayerStore.getState()._resetErrorStreak()
  })
  audio.addEventListener('canplay', () => {
    if (!isActive()) return
    usePlayerStore.getState().setBuffering(false)
  })

  audio.addEventListener('error', () => {
    if (!audio.src) return // sin fuente cargada todavía: no es un error real
    if (!isActive()) return
    const failedSrc = audio.src
    console.warn('[XFY] Error cargando audio')
    usePlayerStore.getState().setBuffering(false)
    // Las pistas de YouTube tienen cadena propia de recuperación (directa →
    // proxy → IFrame) antes de declarar la canción como fallada.
    void usePlayerStore
      .getState()
      ._attemptYtAudioRecovery(failedSrc)
      .then((handled) => {
        if (handled) return
        // Diagnóstico best-effort de fallas de medios externos.
        if (/^https?:/.test(failedSrc)) {
          void diagnoseMediaFailure(failedSrc).then((reason) => {
            console.warn('[XFY] Diagnóstico:', reason)
          })
        }
        usePlayerStore.getState().handleTrackError()
      })
  })

  return audio
}
