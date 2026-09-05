import { useEffect, useRef } from 'react'
import { usePlayerStore } from '@features/player/store/usePlayerStore'
import { loadYouTubeApi, type YTPlayer } from '@features/player/lib/youtubeApi'

/**
 * YouTube IFrame Player API integration.
 * Acts as the source of truth for playback when the current track is from YouTube.
 * Mounts a hidden iframe that can be styled to show the actual video when active.
 */
// El IFrame Player API a veces reporta getDuration() inflado (~2x la
// duración real) mientras el video todavía está resolviendo el stream
// (calidad/formato en transición, DVR window, etc.) — el mismo problema
// que ya se resolvió para el motor 'audio' en AudioEngine.jsx. Aplicamos
// acá el mismo criterio: si ya tenemos una duración de catálogo confiable
// (YT Music/Apple) y lo reportado la excede por mucho, la ignoramos.
function applyReportedYtDuration(reported: number) {
  if (!reported || !Number.isFinite(reported) || reported <= 0) return
  const store = usePlayerStore.getState()
  const catalogDuration = store.duration
  if (catalogDuration > 0 && reported > catalogDuration * 1.4) return
  if (Math.abs(reported - catalogDuration) > 0.5) store.setDuration(reported)
}

export default function YouTubeEngine() {
  const hostRef = useRef<HTMLDivElement>(null)
  const playerRef = useRef<YTPlayer | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const registerYouTubeController = usePlayerStore((s) => s.registerYouTubeController)

  useEffect(() => {
    let destroyed = false

    loadYouTubeApi().then((YT) => {
      if (destroyed || !hostRef.current) return

      const player = new YT.Player(hostRef.current, {
        width: '100%',
        height: '100%',
        playerVars: {
          autoplay: 0,
          controls: 0,
          disablekb: 1,
          modestbranding: 1,
          rel: 0,
          playsinline: 1,
          iv_load_policy: 3,
          fs: 0,
          // Set origin to prevent postMessage target origin mismatch warnings.
          origin: window.location.origin,
        },
        events: {
          onReady: () => {
            playerRef.current = player
            const store = usePlayerStore.getState()
            player.setVolume(Math.round(store.volume * 100))
            registerYouTubeController(makeController(player))
          },
          onStateChange: (e) => {
            const store = usePlayerStore.getState()
            // Only react if YouTube is the currently active engine.
            if (store._engine !== 'youtube') return
            const YTState = window.YT?.PlayerState
            if (!YTState) return
            if (e.data === YTState.ENDED) {
              store.handleEnded()
            } else if (e.data === YTState.PLAYING) {
              store._setPlayingFromEngine(true)
              applyReportedYtDuration(player.getDuration() || 0)
              store.setBuffering(false)
              store._resetErrorStreak()
            } else if (e.data === YTState.PAUSED) {
              store._setPlayingFromEngine(false)
            } else if (e.data === YTState.BUFFERING) {
              store.setBuffering(true)
            } else if (e.data === YTState.CUED) {
              store.setBuffering(false)
              // loadVideoById() debería reproducir solo, pero a veces el
              // iframe se queda "colgado" en CUED sin arrancar (bug conocido
              // del IFrame API) — si el store espera que esté sonando,
              // forzamos el play en vez de dejarlo esperando indefinidamente.
              if (store.isPlaying) {
                try {
                  player.playVideo()
                } catch {
                  /* noop */
                }
              }
            }
          },
          onError: (e) => {
            // Handle playback errors (e.g. invalid ID, not found, embedding disabled) by skipping track.
            console.warn('[YouTubeEngine] error del reproductor:', e?.data)
            const store = usePlayerStore.getState()
            if (store._engine !== 'youtube') return
            store.setBuffering(false)
            store.handleTrackError()
          },
        },
      })
    }).catch((err) => {
      // El script del IFrame API nunca cargó (timeout/red/ad-blocker — ver
      // youtubeApi.ts). Antes esto quedaba silencioso: ytController nunca
      // se registraba y la canción se quedaba trabada en "Preparando
      // audio…" para siempre. Si justo estábamos esperando este motor
      // para reproducir algo, avisamos y saltamos la pista en vez de
      // dejar al usuario mirando un spinner infinito.
      if (destroyed) return
      console.warn('[XFY] IFrame de YouTube no disponible:', err)
      const store = usePlayerStore.getState()
      if (store._engine === 'youtube' && !store.ytController) {
        store.setBuffering(false)
        store.handleTrackError()
      }
    })

    return () => {
      destroyed = true
      if (pollRef.current) clearInterval(pollRef.current)
      try {
        playerRef.current?.destroy?.()
      } catch {
        /* noop */
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /** 
   * Factory for the controller object exposed to the player store.
   * Encapsulates polling since the YouTube API does not emit timeupdate events.
   */
  function makeController(player: YTPlayer) {
    const startPolling = () => {
      if (pollRef.current) clearInterval(pollRef.current)
      pollRef.current = setInterval(() => {
        const store = usePlayerStore.getState()
        if (store._engine !== 'youtube') return
        try {
          const t = player.getCurrentTime?.() || 0
          store.setCurrentTime(t)
          const d = player.getDuration?.() || 0
          applyReportedYtDuration(d)
        } catch {
          /* Iframe might not be fully initialized during this tick. */
        }
      }, 250)
    }
    const stopPolling = () => {
      if (pollRef.current) {
        clearInterval(pollRef.current)
        pollRef.current = null
      }
    }

    return {
      // `startSeconds` permite retomar en el punto exacto donde se venía
      // escuchando — clave para que una recuperación blob→iframe a mitad
      // de canción no se note como un salto al principio del tema.
      load: (videoId: string, startSeconds = 0) => {
        startPolling()
        player.loadVideoById({ videoId, startSeconds })
        // Refuerzo: loadVideoById "debería" autoreproducir, pero en algunos
        // navegadores/estados se queda pensando sin arrancar. Un playVideo()
        // explícito inmediatamente después es inofensivo si ya está
        // reproduciendo, y evita tener que pausar/reproducir a mano.
        try {
          player.playVideo()
        } catch {
          /* noop */
        }
      },
      play: () => {
        startPolling()
        player.playVideo()
      },
      pause: () => player.pauseVideo(),
      stop: () => {
        stopPolling()
        try {
          player.stopVideo()
        } catch {
          /* noop */
        }
      },
      seek: (t: number) => player.seekTo(t, true),
      setVolume: (v: number) => player.setVolume(Math.round(v * 100)),
      getCurrentTime: () => {
        try {
          return player.getCurrentTime?.() || 0
        } catch {
          return 0
        }
      },
    }
  }

  return (
    <div id="yt-engine-mount" aria-hidden="true">
      {/* .yt-cover acts as a stable wrapper to apply object-fit scaling, since the inner div is replaced by an iframe. */}
      <div className="yt-cover">
        <div ref={hostRef} />
      </div>
    </div>
  )
}
