import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { usePlayerStore } from '@features/player/store/usePlayerStore'
import { useArtworkStore } from '@features/player/store/useArtworkStore'
import { buildArtworkLadder, type MediaSessionArtwork } from '@shared/lib/artworkQuality'
import { createWorkerInterval } from '@shared/lib/workerTicker'

/** Synchronizes player state with the browser's Media Session API for lock screen and background controls. */
export default function MediaSessionSync() {
  const song = usePlayerStore((s) => s.queue[s.currentIndex] || null)
  const isPlaying = usePlayerStore((s) => s.isPlaying)
  const duration = usePlayerStore((s) => s.duration)
  const currentTime = usePlayerStore((s) => s.currentTime)
  const resolveArtwork = useArtworkStore((s) => s.resolve)
  const resolvedArtwork = useArtworkStore((s) => (song ? s.artwork[String(song.id)] : undefined))

  const songIdRef = useRef(song?.id)
  useEffect(() => {
    if (songIdRef.current !== song?.id) {
      if (song) resolveArtwork({ id: song.id, title: song.title, artist: song.artist, albumArtUrl: song.albumArtUrl })
      songIdRef.current = song?.id
    }
  }, [song, song?.id, song?.title, song?.artist, song?.albumArtUrl, resolveArtwork])

  // Portada elegida para la notificación: la mejor disponible HOY. Se
  // re-resuelve como ladder max-res en el effect de metadata de abajo.
  const artworkUrl = resolvedArtwork || song?.albumArtUrl || null

  // Media metadata con portada en máxima calidad REAL.
  //
  // Antes se declaraba sizes 96x96/256x256/512x512 contra la misma URL sin
  // importar su resolución verdadera — iOS/Android escalan al sizes
  // declarado y una imagen de 1200px declarada "512x512" se veía borrosa en
  // la pantalla de bloqueo. Ahora buildArtworkLadder() sube la URL a su
  // variante max-res (mzstatic 1200x1200, googleusercontent w1200-h1200),
  // mide las dimensiones reales y las declara tal cual.
  const [artworkLadder, setArtworkLadder] = useState<MediaSessionArtwork[]>([])
  useEffect(() => {
    let cancelled = false
    setArtworkLadder([])
    if (!artworkUrl) return undefined
    buildArtworkLadder(artworkUrl).then((ladder) => {
      if (!cancelled && ladder.length > 0) setArtworkLadder(ladder)
    })
    return () => {
      cancelled = true
    }
  }, [artworkUrl])

  useEffect(() => {
    if (!('mediaSession' in navigator)) return
    if (!song) {
      navigator.mediaSession.metadata = null
      return
    }
    navigator.mediaSession.metadata = new MediaMetadata({
      title: song.title || 'XFY',
      artist: song.artist || '',
      album: song.album || 'XFY',
      artwork: artworkLadder,
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [song?.id, song?.title, song?.artist, song?.album, artworkLadder])

  // Action handlers mapped to zustand store getters for fresh state on interaction.
  //
  // Se RE-registran en cada cambio de canción (deps con song?.id): varios
  // navegadores limpian los handlers cuando el elemento de media cambia de
  // src (nuestro <audio> cambia por pista) o cuando el metadata se
  // reemplaza — registrando una sola vez al montar aparecen controles
  // muertos o incompletos en la notificación de algunos dispositivos.
  // Sin previoustrack/nexttrack registrados Chrome/Android ni siquiera
  // dibuja los botones de skip; sin seekto no hay scrubber.
  useEffect(() => {
    if (!('mediaSession' in navigator)) return undefined
    const store = usePlayerStore

    const handlers: Partial<Record<MediaSessionAction, MediaSessionActionHandler>> = {
      play: () => store.getState().play(),
      pause: () => store.getState().pause(),
      previoustrack: () => store.getState().previous(),
      nexttrack: () => store.getState().next(),
      seekto: (details) => {
        if ('seekTime' in details && details.seekTime != null) store.getState().seek(details.seekTime)
      },
      seekbackward: (details) => {
        const s = store.getState()
        s.seek(Math.max(0, s.currentTime - (('seekOffset' in details && details.seekOffset) || 10)))
      },
      seekforward: (details) => {
        const s = store.getState()
        s.seek(Math.min(s.duration, s.currentTime + (('seekOffset' in details && details.seekOffset) || 10)))
      },
      stop: () => store.getState().pause(),
    }

    ;(Object.entries(handlers) as [MediaSessionAction, MediaSessionActionHandler][]).forEach(([action, handler]) => {
      try {
        navigator.mediaSession.setActionHandler(action, handler)
      } catch {
        // Action not supported on this platform.
      }
    })

    return () => {
      ;(Object.keys(handlers) as MediaSessionAction[]).forEach((action) => {
        try {
          navigator.mediaSession.setActionHandler(action, null)
        } catch {
          // no-op
        }
      })
    }
  }, [song?.id])

  // Playback state explícito tras cada registro — algunos Android resetean
  // playbackState junto con los handlers y el botón queda tildado en play.
  useEffect(() => {
    if (!('mediaSession' in navigator)) return
    navigator.mediaSession.playbackState = isPlaying ? 'playing' : 'paused'
  }, [isPlaying, song?.id])

  // Current playback position and duration for the lock-screen scrubber.
  useEffect(() => {
    if (!('mediaSession' in navigator) || !('setPositionState' in navigator.mediaSession)) return
    if (!duration || !Number.isFinite(duration) || duration <= 0) return
    try {
      navigator.mediaSession.setPositionState({
        duration,
        playbackRate: 1,
        position: Math.min(currentTime, duration),
      })
    } catch {
      // Ignore transient mismatch errors during track changes.
    }
  }, [duration, currentTime])

  // --- iOS Background Audio Recovery Workaround ---
  // Detects when the app returns to foreground to resume audio halted by WebKit's background policies.
  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState !== 'visible') return
      const store = usePlayerStore.getState()

      // Una pista quedó bloqueada por NotAllowedError (avance automático en
      // background sin gesto reciente). El único camino de reintento hasta
      // ahora era un 'pointerdown' — pero Face ID/huella o volver a la app
      // desde el selector de apps NO dejan un toque real en el documento,
      // así que la música se quedaba muda para siempre aunque el usuario
      // ya estuviera mirando la pantalla desbloqueada. Reintentamos acá
      // directo, y si igual sigue bloqueada avisamos con un toast en vez
      // de fallar en silencio (antes no había ningún indicio visual).
      if (store._autoplayBlockedFor && !store.isPlaying) {
        void store._retryBlockedAutoplay().then((resumed) => {
          if (!resumed) {
            toast.info('Reproducción pausada', {
              description: 'iOS la frenó en segundo plano — tocá play para seguir.',
            })
          }
        })
        return
      }

      if (!store.isPlaying) return
      if (store._engine === 'youtube') {
        store.ytController?.play()
      } else if (store.audioEl?.paused) {
        store.audioEl.play().catch(() => {
          // Playback might still be blocked if there was no recent user gesture.
        })
      }
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    // Catch bfcache restoration in iOS.
    window.addEventListener('pageshow', onVisibilityChange)
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange)
      window.removeEventListener('pageshow', onVisibilityChange)
    }
  }, [])

  // --- Audio Session API (Safari/iOS 16.4+) ---
  // Sin esto, iOS trata el audio de la web como "ambient": el switch de
  // silencio lo apaga y al bloquear el teléfono muere. Declarar la sesión
  // como "playback" es lo que iguala el comportamiento al de una app de
  // música nativa (Spotify/Apple Music): suena con el teléfono en silencio,
  // sobrevive al lock screen y aparece en el selector de salida de audio.
  // Feature-checked: en plataformas sin la API es un no-op total.
  useEffect(() => {
    const nav = navigator as Navigator & { audioSession?: { type: 'ambient' | 'playback' | 'auto' } }
    if (nav.audioSession) nav.audioSession.type = 'playback'
  }, [])

  // --- Recuperación ante corte de red (móvil) ---
  // En la calle la conexión se corta y vuelve constantemente (túnel, cambio
  // Wi-Fi ↔ datos). Si la pista actual murió por eso (audioEl.error), al
  // volver la conectividad recargamos EXACTAMENTE donde iba y reanudamos —
  // antes había que saltar manualmente a otra canción.
  useEffect(() => {
    const onOnline = () => {
      const s = usePlayerStore.getState()
      if (!s.isPlaying || s._engine !== 'audio') return
      const el = s.audioEl
      if (!el || !el.src) return

      if (el.error) {
        const resumeAt = el.currentTime
        el.load()
        try {
          el.currentTime = resumeAt
        } catch {
          /* src aún no listo para seek: arranca de 0 */
        }
        el.play().catch(() => {})
        return
      }

      // Sin `error` pero pausado: el elemento se quedó "stalleado" en
      // silencio (típico salto Wi-Fi↔datos en iOS que nunca dispara el
      // evento error) mientras la pestaña estaba VISIBLE — el watchdog de
      // arriba solo corre oculto, así que este es el único lugar que lo
      // cubre en primer plano. Alcanza con reanudar, sin recargar el src.
      if (el.paused) el.play().catch(() => {})
    }
    window.addEventListener('online', onOnline)
    return () => window.removeEventListener('online', onOnline)
  }, [])

  // --- Watchdog de segundo plano ---
  // El navegador NO garantiza que lo que dejaste sonando siga sonando:
  //  · iOS interrumpe por llamadas/Siri y a veces no reanuda;
  //  · Android (Doze/batería) congela elementos de media sin sesión activa;
  //  · WebKit tiene regresiones donde el <audio> queda ZOMBIE tras
  //    background/reapertura en PWA y play() sobre él nunca revive
  //    (iOS 26, bug 295518) — la cura conocida es RECREAR el elemento.
  // Corre cada 5s vía Web Worker (los timers normales se recortan a ~1/min
  // ocultos), SOLO mientras la app está oculta y creemos que hay música:
  //
  //   1. Motor <audio>: si el store dice "reproduciendo" pero el elemento
  //      está pausado (divergencia = algo externo lo frenó; una pausa del
  //      usuario siempre pasa isPlaying a false), se reanuda. Si falla 2
  //      veces seguidas → se RECREA el elemento (zombie cure) y se reintenta
  //      una vez. Tope de rescates por pista para no pelear una llamada.
  //   2. Motor YouTube: desde ene-2026 YouTube corta su player en background
  //      server-side — revivirlo es batalla perdida, así que solo se hace
  //      UN intento suave por episodio de trabado (algunos desktops aún
  //      permiten); el camino real de escape es el blob, cuyo polling corre
  //      también por worker (ver watchCacheReady).
  //   3. Scrubber del lock screen re-sincronizado con la posición REAL.
  useEffect(() => {
    let lastYtTime: number | null = null
    let lastYtReviveAt = 0
    let consecutiveResumeFails = 0
    let recreationsThisTrack = 0
    let rescuedForSongId = ''
    // --- Detección de "reproducción fantasma" ---
    // Bug de WebKit ampliamente reportado (iOS 17/26, foros de Apple
    // Developer): tras un cambio de pista en segundo plano, play() a veces
    // RESUELVE (audioEl.paused pasa a false, mediaSession dice "playing")
    // pero el audio device nunca arrancó — no suena nada y currentTime
    // queda congelado. Como no hay rechazo de play() ni evento 'error',
    // la rama de arriba (basada en el.paused) nunca lo detecta: hay que
    // vigilar que el tiempo REALMENTE avance, no solo que el elemento
    // "diga" que está reproduciendo.
    let lastAudioTime = -1
    let frozenTicks = 0

    const syncLockScreenPosition = (el: HTMLAudioElement, duration: number): void => {
      if (!('mediaSession' in navigator) || !('setPositionState' in navigator.mediaSession)) return
      if (!Number.isFinite(duration) || duration <= 0) return
      try {
        navigator.mediaSession.setPositionState({
          duration,
          playbackRate: el.playbackRate || 1,
          position: Math.min(el.currentTime, duration),
        })
      } catch {
        /* transitorio durante cambios de pista */
      }
    }

    const stopTicker = createWorkerInterval(() => {
      if (document.visibilityState === 'visible') {
        lastYtTime = null
        lastAudioTime = -1
        frozenTicks = 0
        return
      }
      const s = usePlayerStore.getState()
      if (!s.isPlaying) return

      // Reset de contadores al cambiar de pista: cada canción merece sus
      // propios rescates (y los límites no se arrastran entre temas).
      const songId = String(s.queue[s.currentIndex]?.id ?? '')
      if (songId !== rescuedForSongId) {
        rescuedForSongId = songId
        consecutiveResumeFails = 0
        recreationsThisTrack = 0
        lastAudioTime = -1
        frozenTicks = 0
      }

      if (s._engine === 'audio') {
        const el = s.audioEl
        if (!el || !el.src || el.error || el.ended) return

        if (el.paused) {
          frozenTicks = 0
          // Divergencia estado↔elemento: interrupción o throttling externo.
          el.play().then(
            () => {
              consecutiveResumeFails = 0
              syncLockScreenPosition(el, s.duration)
            },
            () => {
              consecutiveResumeFails += 1
              // Elemento zombie (WebKit): play() sobre él jamás suena.
              // Recrear con el mismo src ES la cura documentada.
              if (
                consecutiveResumeFails >= 2 &&
                recreationsThisTrack < 2 &&
                typeof s._recreateAudioEl === 'function'
              ) {
                console.warn('[XFY] <audio> zombie en segundo plano — recreando elemento')
                recreationsThisTrack += 1
                consecutiveResumeFails = 0
                s._recreateAudioEl()
                const fresh = usePlayerStore.getState().audioEl
                fresh
                  ?.play()
                  .then(() => {
                    // Resincronizar YA el scrubber del lock screen/CarPlay:
                    // sin esto queda pegado a la posición del elemento
                    // zombie hasta el próximo tick (hasta 5s de salto visible).
                    if (fresh) syncLockScreenPosition(fresh, usePlayerStore.getState().duration)
                  })
                  .catch(() => {})
              }
            },
          )
          return
        }

        // "Reproducción fantasma": el.paused === false y sin buffering
        // visible, pero el tiempo no avanzó desde el tick anterior. Con
        // readyState en HAVE_FUTURE_DATA+ eso descarta un buffering
        // legítimo (que dispararía 'waiting' → s.isBuffering true) — es
        // la firma del audio device muerto tras el cambio de pista en
        // background. Dos ticks congelados (10s) para no confundir con
        // un buffering real que el navegador tardó en reportar.
        const looksHealthyButFrozen =
          !s.isBuffering && el.readyState >= 2 && lastAudioTime >= 0 && Math.abs(el.currentTime - lastAudioTime) < 0.05
        lastAudioTime = el.currentTime

        if (looksHealthyButFrozen) {
          frozenTicks += 1
          if (frozenTicks >= 2 && recreationsThisTrack < 2 && typeof s._recreateAudioEl === 'function') {
            console.warn('[XFY] Reproducción fantasma en segundo plano (sin avance de tiempo) — recreando elemento')
            recreationsThisTrack += 1
            frozenTicks = 0
            const resumeAt = el.currentTime
            s._recreateAudioEl()
            const fresh = usePlayerStore.getState().audioEl
            fresh
              ?.play()
              .then(() => {
                lastAudioTime = resumeAt
                if (fresh) syncLockScreenPosition(fresh, usePlayerStore.getState().duration)
              })
              .catch(() => {})
          }
          return
        }
        frozenTicks = 0

        syncLockScreenPosition(el, s.duration)
        return
      }

      // Motor YouTube (IFrame): un solo intento de revivir por episodio
      // (cada ≥20s). El escape REAL es el upgrade al blob, que corre en
      // paralelo con polling inmune a throttling (watchCacheReady).
      const yt = s.ytController
      if (!yt) return
      const t = yt.getCurrentTime?.()
      if (t == null) return
      // Pista terminada: dejar que handleEnded haga su trabajo.
      if (s.duration > 0 && t >= s.duration - 1.5) {
        lastYtTime = t
        return
      }
      if (lastYtTime != null && Math.abs(t - lastYtTime) < 0.1 && !s.isBuffering) {
        const now = Date.now()
        if (now - lastYtReviveAt > 20_000) {
          lastYtReviveAt = now
          try {
            yt.play()
          } catch {
            /* noop */
          }
        }
      }
      lastYtTime = t
    }, 5000)

    return () => {
      stopTicker()
    }
  }, [])

  // --- Now-playing en el título de la app ---
  // El task switcher de móvil y las pestañas de escritorio muestran el
  // título del documento: con canción suena, "XFY" pasa a ser
  // "Canción · Artista" — el detalle barato que hace que se vea vivo.
  const nowPlayingTitle = song ? `${song.title}${song.artist ? ` · ${song.artist}` : ''}` : null
  useEffect(() => {
    if (nowPlayingTitle && isPlaying) {
      document.title = nowPlayingTitle
    } else {
      document.title = 'XFY'
    }
    return () => {
      document.title = 'XFY'
    }
  }, [nowPlayingTitle, isPlaying])

  return null
}
