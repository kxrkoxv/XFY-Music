import { useEffect, useRef } from 'react'
import { Kawarp } from '@kawarp/core'

// Fondo animado tipo "Apple Music / Spicy Lyrics": la portada del tema,
// desenfocada y con un efecto de distorsión orgánica en movimiento
// continuo, detrás del reproductor. Usamos @kawarp/core directo — es la
// misma librería (MIT, standalone) que usa dynamicBackground.ts en la
// extensión original; ahí el archivo real son ~500 líneas de plomería
// específica de Spotify (rasterizar covers locales tipo spotify:local:,
// fondos de artista, etc.) alrededor de esta misma librería. Como tus
// portadas ya son URLs normales, no necesitás nada de eso.
//
// `coverUrl`: URL de la portada actual (song.cover)
// `tintRgbFloat`: [r,g,b] 0-1 — color de tinte adaptativo (ver
//   useAdaptiveTheme). Si no se pasa, usa el morado de XFY por defecto.
interface DynamicBackgroundProps {
  coverUrl?: string | null
  className?: string
  // useAdaptiveTheme expone number[] (extractPalette); Kawarp quiere la tupla.
  tintRgbFloat?: number[]
  /** Estado real de reproducción: al pausar, se congela el render loop de
   * Kawarp (deja de warpear) en vez de seguir moviéndose de fondo — mismo
   * criterio que MotionArt, para que el 90%+ de canciones (las que no
   * tienen motion art de Apple Music y dependen de este fondo) también
   * "se queden quietas" en la portada al pausar. undefined preserva el
   * comportamiento anterior (siempre animando). */
  isPlaying?: boolean
}

export default function DynamicBackground({ coverUrl, className, tintRgbFloat, isPlaying }: DynamicBackgroundProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const kawarpRef = useRef<Kawarp | null>(null)
  // Leído dentro del efecto de carga de imagen sin volver a dispararlo:
  // solo decide si, apenas termina de cargar, arranca animando o se queda
  // congelado (si la canción ya estaba en pausa cuando cambió el tema).
  const isPlayingRef = useRef(isPlaying)
  useEffect(() => {
    isPlayingRef.current = isPlaying
  }, [isPlaying])

  // Instancia única de Kawarp, vive mientras el componente esté montado
  useEffect(() => {
    if (!canvasRef.current) return undefined

    const kawarp = new Kawarp(canvasRef.current, {
      warpIntensity: 0.85,
      blurPasses: 8,
      animationSpeed: 0.12,
      saturation: 1.4,
      // Tinte inicial: morado de XFY. Se sobreescribe en vivo apenas
      // useAdaptiveTheme extrae un color real (ver efecto de abajo).
      tintColor: (tintRgbFloat as [number, number, number]) || [0.545, 0.361, 0.961],
      tintIntensity: 0.12,
      dithering: 0.008,
      transitionDuration: 900,
      scale: 1.15,
    })
    kawarpRef.current = kawarp

    const handleResize = () => kawarp.resize()
    window.addEventListener('resize', handleResize)

    return () => {
      window.removeEventListener('resize', handleResize)
      kawarp.dispose()
      kawarpRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // El tinte sí se actualiza en vivo cuando cambia el color adaptativo
  // (Kawarp expone un setter, no hace falta recrear el canvas/WebGL por
  // cada cambio de color — eso sería carísimo).
  useEffect(() => {
    if (kawarpRef.current && tintRgbFloat) {
      kawarpRef.current.tintColor = tintRgbFloat as [number, number, number]
    }
  }, [tintRgbFloat])

  // Cambia de portada con crossfade cada vez que cambia la canción
  useEffect(() => {
    const kawarp = kawarpRef.current
    if (!kawarp || !coverUrl) return undefined

    let cancelled = false
    ;(async () => {
      try {
        await kawarp.loadImage(coverUrl)
        if (!cancelled && isPlayingRef.current !== false) kawarp.start()
      } catch {
        // Si falla la carga (CORS, red, etc.) simplemente no hay fondo animado
        // — no rompe el resto del reproductor.
      }
    })()

    return () => {
      cancelled = true
    }
  }, [coverUrl])

  // Pausa/reanuda el render loop en vivo con el play/pause real de la
  // canción — sin esto Kawarp seguía deformando la imagen de fondo para
  // siempre, sin importar si el audio sonaba o no.
  useEffect(() => {
    const kawarp = kawarpRef.current
    if (!kawarp || isPlaying === undefined) return
    if (isPlaying) kawarp.start()
    else kawarp.stop()
  }, [isPlaying])

  return <canvas ref={canvasRef} className={className} aria-hidden="true" />
}
