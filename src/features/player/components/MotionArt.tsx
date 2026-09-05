import { useEffect, useRef, useState } from 'react'
import type Hls from 'hls.js'
import type { PlayerSong } from '@features/player/store/usePlayerStore'
import './MotionArt.css'

// Bump on changes to api/motionart.js matching logic — invalidates the
// browser's 24h cache of old /api/motionart responses.
const MOTIONART_ALGO_VERSION = '2'

// Dedupe en el cliente: PlayerPage monta DOS MotionArt por canción
// (portada + fondo de letras) con los MISMOS params y en el mismo tick.
// Sin esto viajan dos requests idénticos y el server paga dos veces el
// scrape completo de Apple Music (hasta 6 fetches escalonados cada uno).
const inflightQueries = new Map<string, Promise<{ url?: string | null } | null>>()

function fetchMotionArtUrl(queryString: string): Promise<{ url?: string | null } | null> {
  const pending = inflightQueries.get(queryString)
  if (pending) return pending
  const p = fetch(`/api/motionart?${queryString}`)
    .then((r) => (r.ok ? r.json() : null))
    .finally(() => {
      inflightQueries.delete(queryString)
    })
  inflightQueries.set(queryString, p)
  return p
}

interface MotionArtProps {
  song: PlayerSong
  type?: 'background' | 'cover'
  /** called once on mount with the underlying <video> node (stable for the component's lifetime). */
  onVideoRef?: (video: HTMLVideoElement | null) => void
  /** called with true right as the video starts fading in (`.is-playing`), false when it stops/has no source. */
  onActiveChange?: (active: boolean) => void
  /**
   * Estado real de reproducción de la CANCIÓN (no del video). Cuando es
   * false, el video se pausa y se desvanece hacia la portada estática
   * debajo — así, al pausar, el player se "congela" en la carátula nítida
   * en vez de seguir con el motion blur animando de fondo. `undefined`
   * (default) preserva el comportamiento anterior: el video corre siempre
   * que haya stream, sin importar play/pause de la canción.
   */
  isPlaying?: boolean
}

/**
 * Renders an Apple Music-style animated album cover (HLS stream) as
 * either a full-bleed background or a small cover overlay.
 */
export default function MotionArt({ song, type = 'background', onVideoRef, onActiveChange, isPlaying }: MotionArtProps) {
  const [motionUrl, setMotionUrl] = useState<string | null>(null)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const hlsRef = useRef<Hls | null>(null)
  // Kept in a ref so an inline callback prop doesn't retrigger the HLS effect below.
  const onActiveChangeRef = useRef(onActiveChange)
  useEffect(() => {
    onActiveChangeRef.current = onActiveChange
  }, [onActiveChange])

  useEffect(() => {
    onVideoRef?.(videoRef.current)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Resolve the HLS stream URL for the current song.
  useEffect(() => {
    if (!song) {
      setMotionUrl(null)
      return
    }

    let active = true
    setMotionUrl(null)

    const params = new URLSearchParams({
      title: song.title || '',
      album: song.album || '',
      artist: song.artist || '',
      v: MOTIONART_ALGO_VERSION,
    })

    fetchMotionArtUrl(params.toString())
      .then((d) => {
        if (active && d?.url) setMotionUrl(d.url)
      })
      .catch(() => {}) // static background covers the fallback

    return () => {
      active = false
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [song?.videoId ?? `${song?.title}::${song?.artist}`])

  // Mount / tear down the HLS player whenever the URL changes.
  useEffect(() => {
    const video = videoRef.current
    if (!video) return

    if (!motionUrl) {
      hlsRef.current?.destroy()
      hlsRef.current = null
      video.classList.remove('is-playing')
      video.removeAttribute('src')
      onActiveChangeRef.current?.(false)
      return
    }

    let cancelled = false
    const onReady = () => {
      video.classList.add('is-playing')
      onActiveChangeRef.current?.(true)
    }

    // Safari/iOS reproducen HLS nativo — no descargan hls.js para nada.
    if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = motionUrl
      const onLoadedMetadata = () => {
        video.play().then(onReady).catch(() => {})
      }
      video.addEventListener('loadedmetadata', onLoadedMetadata, { once: true })
    } else {
      // hls.js (~400 kB minificado) por dynamic import: solo lo bajan los
      // browsers sin HLS nativo, y solo cuando hay motion art real. Estático,
      // arrastraba todo ese peso al chunk de PlayerPage en cada primera carga.
      import('hls.js')
        .then(({ default: Hls }) => {
          if (cancelled) return
          const hls = new Hls({
            startLevel: 0,
            debug: false,
          })
          hls.loadSource(motionUrl)
          hls.attachMedia(video)
          hls.on(Hls.Events.MANIFEST_PARSED, () => {
            video.play().then(onReady).catch(() => {})
          })
          hlsRef.current = hls
        })
        .catch(() => {}) // sin motion art no hay nada que recuperar
    }

    return () => {
      cancelled = true
      video.classList.remove('is-playing')
      onActiveChangeRef.current?.(false)
      hlsRef.current?.destroy()
      hlsRef.current = null
    }
  }, [motionUrl, type])

  // --- Congelar en segundo plano ---
  // Un <video> en loop sigue DECODIFICANDO frames aunque nadie lo vea: es
  // la pieza más cara de batería/RAM de todo el reproductor, y el audio no
  // la necesita para nada (el <audio> del engine vive aparte). Al ocultar
  // la pestaña/app: pausa + corte de descarga de segmentos (hls.js); al
  // volver: reanuda exactamente si estaba animándose. El frame congelado
  // queda como fondo estático — visualmente idéntico a una portada fija.
  const wasAnimatingRef = useRef(false)
  useEffect(() => {
    const onVisibility = () => {
      const video = videoRef.current
      if (!video || !video.src) return

      if (document.visibilityState === 'hidden') {
        wasAnimatingRef.current = !video.paused && !video.ended
        if (!video.paused) video.pause()
        try {
          hlsRef.current?.stopLoad()
        } catch {
          /* instancia ya destruida */
        }
      } else if (wasAnimatingRef.current) {
        wasAnimatingRef.current = false
        void video.play().catch(() => {})
        try {
          hlsRef.current?.startLoad()
        } catch {
          /* noop */
        }
      }
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [])

  // --- Congelar en la portada al pausar ---
  // isPlaying refleja el estado real de la canción (play/pause del
  // usuario), distinto de "is-playing" (que solo dice si HAY stream
  // listo). Al pausar: se pausa el <video> (ahorra batería/descarga) y se
  // agrega `.is-paused`, que en CSS lleva la opacidad a 0 — el fondo/
  // carátula animada se desvanece y queda la imagen estática nítida
  // debajo, como una portada de álbum "clásica". Al reanudar, vuelve a
  // fundirse el motion art.
  useEffect(() => {
    const video = videoRef.current
    if (!video || isPlaying === undefined) return
    if (isPlaying) {
      video.classList.remove('is-paused')
      if (video.src && video.paused) void video.play().catch(() => {})
    } else {
      video.classList.add('is-paused')
      if (!video.paused) video.pause()
    }
  }, [isPlaying])

  return (
    <div className={type === 'background' ? 'motion-art-container' : 'motion-art-cover-container'}>
      <video
        ref={videoRef}
        autoPlay
        loop
        muted
        playsInline
        className={type === 'background' ? 'motion-art-video' : 'motion-art-cover-video'}
      />
    </div>
  )
}
