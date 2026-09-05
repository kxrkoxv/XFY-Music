import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { RefObject } from 'react'
import { Languages, MicVocal, Music, Type } from 'lucide-react'
import { usePlayerStore } from '@features/player'
import type { PlayerSong } from '@features/player/store/usePlayerStore'
import { useAutoHideScrollbar } from '@shared/lib/useAutoHideScrollbar'
import useCanHover from '@shared/lib/useCanHover'
import LyricLine from '@features/lyrics/engine/components/LyricLine'

import { fetchLyricsFromLRCLIB, synthesizeTimingFromPlain } from '@features/lyrics/engine/lrclib'
import { useLyricsAutoScroll } from '@features/lyrics/engine/useLyricsAutoScroll'
import { useGlassyStagger } from '@features/lyrics/engine/useGlassyStagger'
import { getYTMusicLyrics } from '@services/api/ytmusic'
import { translateLyrics } from '@services/api/translate'
import { romanizeLyrics } from '@services/api/romanize'
import { isLikelySpanish } from '@features/lyrics/engine/isLikelySpanish'
import { needsRomanization } from '@features/lyrics/engine/needsRomanization'
import type { TTMLWord } from '@features/lyrics/engine/parseTTML'

/** Idioma destino de la traducción — la UI de XFY es en español. */
const TRANSLATION_TARGET_LANG = 'es'
/** Recordar la preferencia "mostrar traducción" entre canciones (no entre dispositivos). */
const TRANSLATION_PREF_KEY = 'xfy:lyrics-translation-enabled'
/** Igual que TRANSLATION_PREF_KEY pero para el toggle de romanización. */
const ROMANIZATION_PREF_KEY = 'xfy:lyrics-romanization-enabled'

/** Línea de letra ya parseada — mismo shape que producen lrclib.js y parseTTML.ts. */
interface LyricLineData {
  time: number
  text: string
  words?: TTMLWord[]
  background?: TTMLWord[]
  oppositeAligned?: boolean
}

type LyricsStatus = 'idle' | 'loading' | 'synced' | 'plain' | 'fallback' | 'none'

type LyricsPanelSong = PlayerSong & {
  lyrics?: LyricLineData[]
  language?: string
}

import '@features/lyrics/engine/spicyLyrics.css'

/** Reads live currentTime directly to bypass zustand's re-renders, optimizing per-word animations. */
const getLiveCurrentTime = () => usePlayerStore.getState().currentTime

/** Threshold to consider a gap between lyric lines as an instrumental break. */
const BREAK_THRESHOLD_S = 3

// Breathing dots indicator for long instrumental breaks between lines.
const BreakDots = memo(function BreakDots({ startTime, endTime }: { startTime: number; endTime: number }) {
  const currentTime = usePlayerStore((s) => s.currentTime)
  const progress = Math.min(1, Math.max(0, (currentTime - startTime) / Math.max(0.1, endTime - startTime)))
  const activeDot = Math.min(2, Math.floor(progress * 3))

  return (
    <div className="lyrics-break" aria-hidden="true">
      {[0, 1, 2].map((i) => (
        <span key={i} className={`lyrics-break-dot ${i === activeDot ? 'pulse' : ''} ${i < activeDot ? 'lit' : ''}`} />
      ))}
    </div>
  )
})

export default function LyricsPanel({
  song,
  artworkUrl,
  onAvailabilityChange,
}: {
  song: LyricsPanelSong
  artworkUrl?: string | null
  onAvailabilityChange?: (available: boolean) => void
}) {
  const currentTime = usePlayerStore((s) => s.currentTime)
  const duration = usePlayerStore((s) => s.duration)
  const seek = usePlayerStore((s) => s.seek)

  const [exactLyrics, setExactLyrics] = useState<LyricLineData[] | null>(null)
  const [lyricsStatus, setLyricsStatus] = useState<LyricsStatus>('idle')
  const [instrumental, setInstrumental] = useState(false)
  const [showTranslation, setShowTranslation] = useState(() => {
    try {
      return localStorage.getItem(TRANSLATION_PREF_KEY) === '1'
    } catch {
      return false
    }
  })
  const [translations, setTranslations] = useState<Record<number, string | null>>({})
  const [showRomanization, setShowRomanization] = useState(() => {
    try {
      return localStorage.getItem(ROMANIZATION_PREF_KEY) === '1'
    } catch {
      return false
    }
  })
  const [romanizations, setRomanizations] = useState<Record<number, string | null>>({})
  const lineRefs = useRef<Record<number, HTMLElement>>({})
  const containerRef = useAutoHideScrollbar<HTMLDivElement>()
  // PC real (hover + puntero fino): activa la variante desktop del motor
  // de letras — tipografía más grande alineada a la izquierda, escalera de
  // indentación por distancia y pops de palabra amplificados (ver
  // .lyrics-panel--desktop en spicyLyrics.css). En móvil/táctil no cambia nada.
  const isDesktop = useCanHover()

  const lyrics = useMemo(() => exactLyrics || song.lyrics || [], [exactLyrics, song.lyrics])

  // Stable reference for line seeking.
  const handleLineClick = useCallback((time: number) => seek(time), [seek])

  /** Fetches lyrics from LRCLIB, falling back to plain text or YouTube Music lyrics if missing. */
  useEffect(() => {
    let cancelled = false
    // Clear immediately to prevent ghost lyrics from the previous track.
    setExactLyrics(null)
    setLyricsStatus('loading')
    setInstrumental(false)
    setTranslations({})
    setRomanizations({})
    const controller = new AbortController()

    async function load() {
      try {
        // LRCLIB (con caché durable en IndexedDB — lyricsCache): cuando el
        // track trae Enhanced LRC, las líneas ya vienen con timing REAL por
        // palabra y el badge muestra "PALABRA A PALABRA". Sin servicios
        // externos, sin claves, sin GPU — 100% Vercel + cliente.
        const result = await fetchLyricsFromLRCLIB({
          title: song.title || '',
          artist: song.artist || '',
          album: song.album,
          duration: song.duration || duration,
          fallbackLyrics: song.lyrics || [],
          signal: controller.signal,
        })
        if (cancelled) return

        if (result?.instrumental) {
          setInstrumental(true)
          setLyricsStatus('none')
          return
        }

        if (result && result.lines.length > 0) {
          setExactLyrics(result.lines)
          setLyricsStatus(result.synced ? 'synced' : 'plain')
          return
        }

        // Fallback to YT Music's built-in lyrics if the source is YouTube.
        const videoId = song.source === 'youtube' ? song.videoId || song.id : null
        if (videoId) {
          // borde JS->TS: ytmusic.ts tipa `lines` como string, pero el
          // endpoint devuelve un array de líneas (por eso abajo se hace .join).
          const ytLines = (await getYTMusicLyrics(videoId as string).catch(() => null)) as unknown as string[] | null
          if (!cancelled && ytLines && ytLines.length > 0) {
            const synthesized = synthesizeTimingFromPlain(ytLines.join('\n'), song.duration || duration, song.lyrics || [])
            if (synthesized.length > 0) {
              setExactLyrics(synthesized)
              setLyricsStatus('plain')
              return
            }
          }
        }

        if (cancelled) return
        setExactLyrics(null)
        setLyricsStatus(song.lyrics?.length ? 'fallback' : 'none')
      } catch {
        if (cancelled) return
        setExactLyrics(null)
        setLyricsStatus(song.lyrics?.length ? 'fallback' : 'none')
      }
    }

    load()
    return () => {
      cancelled = true
      controller.abort()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [song.id, song.title, song.artist, song.album])

  // Notify PlayerPage about lyrics availability to toggle UI buttons without flicker.
  useEffect(() => {
    if (lyricsStatus === 'loading') return
    onAvailabilityChange?.(lyrics.length > 0)
  }, [lyrics.length, lyricsStatus, onAvailabilityChange])

  const toggleTranslation = useCallback(() => {
    setShowTranslation((prev) => {
      const next = !prev
      try {
        localStorage.setItem(TRANSLATION_PREF_KEY, next ? '1' : '0')
      } catch {
        // no crítico
      }
      return next
    })
  }, [])

  const toggleRomanization = useCallback(() => {
    setShowRomanization((prev) => {
      const next = !prev
      try {
        localStorage.setItem(ROMANIZATION_PREF_KEY, next ? '1' : '0')
      } catch {
        // no crítico
      }
      return next
    })
  }, [])

  // No tiene sentido ofrecer "traducir" una letra que ya está en español —
  // se esconde el botón para no gastar cuota de la API ni mostrar una
  // "traducción" casi idéntica al original.
  const alreadySpanish = useMemo(() => isLikelySpanish(lyrics.map((l) => l.text)), [lyrics])

  // Solo tiene sentido ofrecer romanización cuando la letra usa un script
  // no latino (kanji/kana, hangul, cirílico, etc.) — para una letra en
  // inglés/español/portugués el botón no aportaría nada.
  const showsNonLatinScript = useMemo(() => needsRomanization(lyrics.map((l) => l.text)), [lyrics])

  // Traduce línea por línea, en orden, cuando el usuario prende el toggle
  // (o cuando cambia de canción con el toggle ya prendido). onLine va
  // pintando cada línea apenas llega — no hace falta esperar la canción
  // entera para ver la primera traducción.
  useEffect(() => {
    if (!showTranslation || alreadySpanish || lyricsStatus === 'loading' || lyrics.length === 0) return
    const controller = new AbortController()
    translateLyrics(
      lyrics.map((l) => l.text),
      TRANSLATION_TARGET_LANG,
      (index, translation) => {
        setTranslations((prev) => (prev[index] === translation ? prev : { ...prev, [index]: translation }))
      },
      controller.signal,
    )
    return () => controller.abort()
  }, [showTranslation, lyrics, lyricsStatus, alreadySpanish])

  // Mismo patrón que la traducción, pero para romanización — se piden por
  // separado porque son togglees independientes (se puede querer solo uno).
  useEffect(() => {
    if (!showRomanization || !showsNonLatinScript || lyricsStatus === 'loading' || lyrics.length === 0) return
    const controller = new AbortController()
    romanizeLyrics(
      lyrics.map((l) => l.text),
      (index, romanization) => {
        setRomanizations((prev) => (prev[index] === romanization ? prev : { ...prev, [index]: romanization }))
      },
      controller.signal,
    )
    return () => controller.abort()
  }, [showRomanization, lyrics, lyricsStatus, showsNonLatinScript])

  const linesWithBounds = useMemo(() => {
    return lyrics.map((line, i) => {
      const start = Number(line.time) || 0
      const next = lyrics[i + 1]
      const end = next ? Number(next.time) || start + 4 : (duration || start + 5) + 0.01
      // Estimated singing duration per line based on word count.
      const wordCount = String(line.text || '').split(/\s+/).filter(Boolean).length
      const estimatedSingEnd = start + Math.min(end - start, Math.max(0.8, wordCount * 0.35))
      return { ...line, start, end, estimatedSingEnd, index: i }
    })
  }, [lyrics, duration])

  // Instrumental breaks: gaps between estimated end of singing and start of next line.
  const breaks = useMemo(() => {
    const result: { afterIndex: number; start: number; end: number }[] = []
    if (linesWithBounds.length === 0) return result

    const first = linesWithBounds[0]!
    if (first.start - BREAK_THRESHOLD_S > 0) {
      result.push({ afterIndex: -1, start: 0, end: first.start })
    }

    for (let i = 0; i < linesWithBounds.length - 1; i++) {
      const line = linesWithBounds[i]!
      const next = linesWithBounds[i + 1]!
      if (next.start - line.estimatedSingEnd >= BREAK_THRESHOLD_S) {
        result.push({ afterIndex: i, start: line.estimatedSingEnd, end: next.start })
      }
    }
    return result
  }, [linesWithBounds])

  // Búsqueda binaria: linesWithBounds ya está ordenado por start (viene de
  // lyrics, que a su vez está sort()-eado en parseLRC). Con letras largas
  // sincronizadas por palabra (Enhanced LRC puede repetir timestamps por
  // estribillo, +100 líneas) esto evita recorrer el arreglo entero en cada
  // tick de currentTime, que corre a la frecuencia del reproductor de audio.
  const activeIndex = useMemo(() => {
    const lines = linesWithBounds
    if (lines.length === 0) return -1
    if (currentTime < lines[0]!.start) return -1

    let lo = 0
    let hi = lines.length - 1
    while (lo < hi) {
      // +1 evita loop infinito cuando lo === hi - 1
      const mid = (lo + hi + 1) >> 1
      if (lines[mid]!.start <= currentTime) lo = mid
      else hi = mid - 1
    }
    return lo
  }, [linesWithBounds, currentTime])

  // Detecta seeks/saltos bruscos de posición (arrastrar la barra de progreso,
  // saltar de sección, etc.) comparando contra el currentTime del tick
  // anterior — un salto de más de ~1.5s no puede venir de la reproducción
  // normal. Se usa para forzar un scroll instantáneo en vez de animar por
  // todas las líneas de por medio (mismo criterio que wasDrasticPositionChange
  // en ScrollToActiveLine.ts de Spicy Lyrics).
  const prevTimeRef = useRef(0)
  const [seekSignal, setSeekSignal] = useState(0)
  useEffect(() => {
    const prev = prevTimeRef.current
    prevTimeRef.current = currentTime
    if (Math.abs(currentTime - prev) > 1.5) {
      setSeekSignal((n) => n + 1)
    }
  }, [currentTime])

  const { showResumeButton, resumeAutoScroll } = useLyricsAutoScroll({
    // borde JS->TS: la JSDoc del hook JS pide RefObject<HTMLElement> sin null.
    containerRef: containerRef as RefObject<HTMLElement>,
    lineRefs,
    activeIndex,
    resetKey: song.id || song.videoId || song.title,
    forceSignal: seekSignal,
    isSynced: lyricsStatus === 'synced',
  })

  // Gap (segundos) entre el start de la línea recién activada y la
  // anterior — gaps cortos (rap, coros) disparan la variante "rápida" del
  // resorte GlassyFlow (ver useGlassyStagger.js / GLASSY_SPRING_FAST).
  const gapToNext = useMemo(() => {
    if (activeIndex < 0) return null
    const current = linesWithBounds[activeIndex]
    const previous = linesWithBounds[activeIndex - 1]
    if (!current || !previous) return null
    return current.start - previous.start
  }, [linesWithBounds, activeIndex])

  useGlassyStagger({
    lineRefs,
    activeIndex,
    gapToNext,
    resetKey: song.id || song.videoId || song.title,
    seekSignal,
  })

  const lineRefCache = useRef(new Map<number, (el: HTMLElement | null) => void>())
  const setLineRef = useCallback((index: number) => {
    // Stable ref callback per line to prevent unnecessary re-renders.
    let fn = lineRefCache.current.get(index)
    if (!fn) {
      fn = (el: HTMLElement | null) => {
        // borde JS->TS: los hooks JS tipan las refs como HTMLElement, pero
        // React pasa null al desmontar la línea (los consumidores lo toleran).
        lineRefs.current[index] = el!
      }
      lineRefCache.current.set(index, fn)
    }
    return fn
  }, [])

  if (linesWithBounds.length === 0) {
    // Fondo compartido por loading/empty: la portada de la canción,
    // difuminada a pantalla completa del panel — mismo lenguaje visual
    // que el fondo dinámico del reproductor (ver DynamicBackground),
    // en vez de un thumbnail chico suelto en el medio.
    const EmptyBackdrop = artworkUrl ? (
      <img src={artworkUrl} className="lyrics-empty-bg" alt="" aria-hidden="true" draggable={false} />
    ) : null

    if (lyricsStatus === 'loading') {
      return (
        <div className="lyrics-panel lyrics-panel-empty lyrics-panel-loading">
          {EmptyBackdrop}
          <div className="lyrics-empty-scrim" aria-hidden="true" />
          <div className="lyrics-loading-skeleton">
            {[0.8, 1, 0.65, 0.9, 0.7].map((w, i) => (
              <div key={i} className="lyrics-skeleton-line" style={{ width: `${w * 100}%` }} />
            ))}
          </div>
        </div>
      )
    }
    return (
      <div className="lyrics-panel lyrics-panel-empty">
        {EmptyBackdrop}
        <div className="lyrics-empty-scrim" aria-hidden="true" />
        {instrumental ? (
          <div className="lyrics-empty-content">
            <div className="lyrics-empty-icon" aria-hidden="true">
              <Music size={26} strokeWidth={1.75} />
            </div>
            <p className="lyrics-empty-text">Letra instrumental</p>
            <p className="lyrics-empty-subtext">Esta canción no tiene letra — solo disfrutala.</p>
          </div>
        ) : (
          <div className="lyrics-empty-content">
            <div className="lyrics-empty-icon" aria-hidden="true">
              <MicVocal size={26} strokeWidth={1.75} />
            </div>
            <p className="lyrics-empty-text">Sin letras disponibles</p>
            <p className="lyrics-empty-subtext">No encontramos una letra sincronizada para esta canción.</p>
          </div>
        )}
      </div>
    )
  }

  const breakAfter = (index: number) => breaks.find((b) => b.afterIndex === index)
  const introBreak = breaks.find((b) => b.afterIndex === -1)

  const isPlain = lyricsStatus === 'plain' || lyricsStatus === 'fallback'

  // Badge de calidad de la letra, estilo atribución de Apple Music: le dice
  // al usuario QUÉ nivel de sync está viendo sin tener que adivinarlo.
  const sourceBadge =
    lyricsStatus === 'synced'
      ? lyrics.some((l) => l.words && l.words.length > 0)
        ? 'PALABRA A PALABRA'
        : 'SINCRONIZADA'
      : isPlain
        ? 'APROXIMADA'
        : null

  return (
    <div
      className={`lyrics-panel custom-scroll custom-scroll--autohide${isPlain ? ' lyrics-panel--plain' : ''}${isDesktop ? ' lyrics-panel--desktop' : ''}`}
      ref={containerRef}
    >
      <div className="lyrics-panel-toolbar">
        {sourceBadge && (
          <span className={`lyrics-source-badge${isPlain ? ' is-approx' : ''}`}>{sourceBadge}</span>
        )}
        {showsNonLatinScript && (
          <button
            type="button"
            className={`lyrics-translate-btn${showRomanization ? ' active' : ''}`}
            onClick={toggleRomanization}
            aria-pressed={showRomanization}
            title={showRomanization ? 'Ocultar romanización' : 'Mostrar romanización'}
          >
            <Type size={14} strokeWidth={2} />
          </button>
        )}
        {!alreadySpanish && (
          <button
            type="button"
            className={`lyrics-translate-btn${showTranslation ? ' active' : ''}`}
            onClick={toggleTranslation}
            aria-pressed={showTranslation}
            title={showTranslation ? 'Ocultar traducción' : 'Mostrar traducción'}
          >
            <Languages size={14} strokeWidth={2} />
          </button>
        )}
      </div>
      {isPlain && (
        <p className="lyrics-status-hint">Letra sin sincronización exacta — el timing es aproximado.</p>
      )}
      <button
        type="button"
        className={`lyrics-resume-btn${showResumeButton ? ' visible' : ''}`}
        onClick={resumeAutoScroll}
        tabIndex={showResumeButton ? 0 : -1}
        aria-hidden={!showResumeButton}
      >
        Reanudar auto-scroll
      </button>
      {introBreak && currentTime < introBreak.end + 1 && <BreakDots startTime={introBreak.start} endTime={introBreak.end} />}
      {linesWithBounds.map((line) => {
        const isActive = line.index === activeIndex
        const isPast = line.index < activeIndex
        // Distance to active line for progressive blur and scaling.
        const distance = activeIndex === -1 ? 0 : Math.min(4, Math.abs(line.index - activeIndex))
        const brk = breakAfter(line.index)

        return (
          <div key={line.index}>
            <LyricLine
              ref={setLineRef(line.index)}
              text={line.text}
              start={line.start}
              singEnd={line.estimatedSingEnd}
              exactWords={line.words}
              background={line.background}
              oppositeAligned={line.oppositeAligned}
              translation={showTranslation ? translations[line.index] : undefined}
              romanization={showRomanization ? romanizations[line.index] : undefined}
              isActive={isActive}
              isPast={isPast}
              distance={distance}
              getCurrentTime={getLiveCurrentTime}
              onLineClick={handleLineClick}
            />
            {brk && currentTime >= brk.start - 1 && currentTime < brk.end + 1 && (
              <BreakDots startTime={brk.start} endTime={brk.end} />
            )}
          </div>
        )
      })}
    </div>
  )
}