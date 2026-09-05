import { useEffect, useRef, useState } from 'react'
import { animate } from 'motion'
import type { AnimationPlaybackControls } from 'motion'
import { extractDominantColor, buildAdaptiveTheme } from './extractPalette'
import type { AdaptiveTheme, RGB } from './extractPalette'

const DEFAULT_RGB: RGB = [139, 92, 246] // fallback accent (#8b5cf6)
const VIDEO_SAMPLE_INTERVAL_MS = 4000

// Matches the opacity transition MotionArt uses to fade in
// (.motion-art-video in MotionArt.css), so the accent "arrives" in sync
// with the MotionArt itself instead of snapping to a new color.
const MOTION_ART_DURATION_S = 1.4
const MOTION_ART_EASE: [number, number, number, number] = [0.2, 0.8, 0.2, 1]

interface UseAdaptiveThemeOptions {
  coverUrl?: string | null
  videoEl?: HTMLVideoElement | null
  videoActive?: boolean
}

/**
 * Adaptive theme: derives --accent-* colors from the dominant color of
 * the album cover, or — while a MotionArt background is visible — from
 * the current video frame instead.
 *
 * @returns accent theme object, including `rgbFloat` for shader tinting.
 */
export function useAdaptiveTheme({ coverUrl, videoEl, videoActive = false }: UseAdaptiveThemeOptions): AdaptiveTheme {
  const [theme, setTheme] = useState<AdaptiveTheme>(() => buildAdaptiveTheme(DEFAULT_RGB))
  const coverRgbRef = useRef<RGB>(DEFAULT_RGB)
  const currentRgbRef = useRef<RGB>(DEFAULT_RGB)
  const controlsRef = useRef<AnimationPlaybackControls | null>(null)
  const videoActiveRef = useRef(videoActive)
  videoActiveRef.current = videoActive

  const animateTo = (targetRgb: RGB): void => {
    controlsRef.current?.stop()
    const from = { r: currentRgbRef.current[0], g: currentRgbRef.current[1], b: currentRgbRef.current[2] }
    const to = { r: targetRgb[0], g: targetRgb[1], b: targetRgb[2] }
    // `from` is mutated in place by animate(); read it directly in onUpdate.
    controlsRef.current = animate(from, to, {
      duration: MOTION_ART_DURATION_S,
      ease: MOTION_ART_EASE,
      onUpdate: () => {
        const rgb: RGB = [from.r, from.g, from.b]
        currentRgbRef.current = rgb
        setTheme(buildAdaptiveTheme(rgb))
      },
    })
  }

  // Cover-based baseline.
  useEffect(() => {
    if (!coverUrl) return undefined
    let cancelled = false

    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.src = coverUrl

    img.onload = () => {
      if (cancelled) return
      const result = extractDominantColor(img)
      if (!result) return
      coverRgbRef.current = result.rgb
      if (!videoActiveRef.current) animateTo(result.rgb)
    }
    // CORS/network/decoding failures just keep the previous theme.

    return () => {
      cancelled = true
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [coverUrl])

  // Live palette from the MotionArt video, while it's actually visible.
  useEffect(() => {
    if (!videoEl || !videoActive) return undefined

    const sample = () => {
      // App en segundo plano: el canvas no lo ve nadie y getImageData es
      // de las operaciones más caras por frame — el muestreo espera a que
      // vuelva el foco (el intervalo siguiente retoma solo).
      if (typeof document !== 'undefined' && document.hidden) return
      if (videoEl.readyState < 2) return
      const result = extractDominantColor(videoEl)
      if (result) animateTo(result.rgb)
    }

    sample()
    const id = window.setInterval(sample, VIDEO_SAMPLE_INTERVAL_MS)
    return () => window.clearInterval(id)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoEl, videoActive])

  // MotionArt turned off (no art for this song, or still loading): ease back to the cover color.
  useEffect(() => {
    if (!videoActive) animateTo(coverRgbRef.current)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoActive])

  useEffect(() => () => controlsRef.current?.stop(), [])

  return theme
}
