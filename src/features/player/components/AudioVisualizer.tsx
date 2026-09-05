import { useEffect, useRef } from 'react'
import { useAudioAnalyser } from '@shared/lib/useAudioAnalyser'

interface AudioVisualizerProps {
  audioEl: HTMLAudioElement | null
  active: boolean
  className?: string
  /** Reflejo tenue debajo de las barras, estilo Apple Music "Now Playing"
   *  (2026: vidrio + reflejo en vez del bloque sólido de siempre). Default
   *  true — desactivalo si el contenedor donde vive no tiene alto de sobra. */
  mirror?: boolean
  barCount?: number
}

/**
 * Barras estilo ecualizador que reaccionan al audio real que está sonando
 * (no una animación fake). Se dibuja en <canvas> con requestAnimationFrame
 * propio — no usa React state por frame para no generar 60 renders/seg.
 * Usa las variables CSS --accent/--accent-strong (ya calculadas por el tema
 * adaptativo del PlayerPage a partir de la portada) para quedar coherente
 * con el resto del fondo, sin necesidad de props de color.
 *
 * v2: cada barra es un degradé (accent-strong arriba → accent abajo) con
 * punta redondeada y un reflejo espejado debajo, en vez del bloque plano
 * de un solo color de la v1 — el mismo lenguaje visual que Apple Music /
 * Spicy Lyrics usan para el "now playing" ambiental.
 */
export default function AudioVisualizer({ audioEl, active, className, mirror = true, barCount = 48 }: AudioVisualizerProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const { getLevels, ready } = useAudioAnalyser(audioEl, active)
  const rafRef = useRef<number | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !active) return undefined

    const ctx2d = canvas.getContext('2d')
    if (!ctx2d) return undefined

    let dpr = Math.min(window.devicePixelRatio || 1, 2)
    const resize = () => {
      const rect = canvas.getBoundingClientRect()
      dpr = Math.min(window.devicePixelRatio || 1, 2)
      canvas.width = Math.max(1, Math.round(rect.width * dpr))
      canvas.height = Math.max(1, Math.round(rect.height * dpr))
    }
    resize()
    const ro = new ResizeObserver(resize)
    ro.observe(canvas)

    const smoothed = new Array(barCount).fill(0)
    // El área se reparte: barras arriba, reflejo abajo con un pequeño hueco
    // entre ambos — igual que una superficie mojada reflejando luz, no un
    // espejo perfecto (por eso el reflejo es más bajo y más tenue).
    const baseRatio = mirror ? 0.62 : 1
    const gapRatio = mirror ? 0.05 : 0

    const draw = () => {
      rafRef.current = requestAnimationFrame(draw)
      const levels = getLevels()
      const w = canvas.width
      const h = canvas.height
      ctx2d.clearRect(0, 0, w, h)
      if (!levels) return // aún sin datos (autoplay policy / conectando) — no dibuja nada raro

      const style = getComputedStyle(canvas)
      const accent = style.getPropertyValue('--accent').trim() || '#8b5cf6'
      const accentStrong = style.getPropertyValue('--accent-strong').trim() || accent

      const baseH = h * baseRatio
      const gap = h * gapRatio
      const barWidth = w / barCount
      const bandStep = Math.floor(levels.length / barCount) || 1
      const radius = Math.min(barWidth * 0.35, 6 * dpr)

      for (let i = 0; i < barCount; i++) {
        const bandIndex = Math.min(levels.length - 1, i * bandStep)
        const raw = levels[bandIndex] ?? 0
        const target = raw / 255
        smoothed[i] += (target - smoothed[i]) * 0.3 // suaviza sin lag notorio
        const barH = Math.max(2 * dpr, smoothed[i] * baseH)
        const x = i * barWidth + barWidth * 0.18
        const bw = barWidth * 0.64
        const y = baseH - barH

        const grad = ctx2d.createLinearGradient(0, y, 0, baseH)
        grad.addColorStop(0, accentStrong)
        grad.addColorStop(1, accent)
        ctx2d.fillStyle = grad
        ctx2d.globalAlpha = 0.22 + smoothed[i] * 0.62
        drawRoundedBar(ctx2d, x, y, bw, barH, radius)

        if (mirror) {
          const reflH = barH * 0.42
          const ry = baseH + gap
          ctx2d.globalAlpha = 0.1 + smoothed[i] * 0.22
          ctx2d.fillStyle = accent
          drawRoundedBar(ctx2d, x, ry, bw, reflH, radius)
        }
      }
      ctx2d.globalAlpha = 1
    }

    rafRef.current = requestAnimationFrame(draw)

    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
      ro.disconnect()
    }
  }, [active, getLevels, mirror, barCount])

  if (!active) return null

  return (
    <canvas
      ref={canvasRef}
      className={className}
      aria-hidden="true"
      style={{ opacity: ready ? 1 : 0, transition: 'opacity 0.6s ease' }}
    />
  )
}

function drawRoundedBar(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rad = Math.min(r, w / 2, h / 2)
  ctx.beginPath()
  if (typeof ctx.roundRect === 'function') {
    // Solo las puntas de arriba redondeadas — la base se funde con el
    // "piso" imaginario del bloque de barras, como en Apple Music.
    ctx.roundRect(x, y, w, Math.max(h, 1), [rad, rad, 0, 0])
  } else {
    ctx.rect(x, y, w, Math.max(h, 1))
  }
  ctx.fill()
}
