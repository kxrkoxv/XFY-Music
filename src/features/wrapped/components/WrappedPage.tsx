import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { motion, AnimatePresence, useReducedMotion } from 'motion/react'
import { ArrowLeft, ArrowRight, Share2, X, Music2, Clock, Flame, Disc3 } from 'lucide-react'
import { toast } from 'sonner'
import { smartGoBack } from '@shared/lib/backStack'
import { getWrappedStats, formatMinutes, type Period } from '@shared/lib/metrics'
import CachedImg from '@shared/components/CachedImg'
import './WrappedPage.css'

const PERIODS: { id: Period; label: string }[] = [
  { id: '30d', label: 'Últimos 30 días' },
  { id: 'all', label: 'Desde siempre' },
]

export default function WrappedPage() {
  const navigate = useNavigate()
  const reduceMotion = useReducedMotion()
  const [period, setPeriod] = useState<Period>('30d')
  const [slide, setSlide] = useState(0)

  const stats = useMemo(() => getWrappedStats(period), [period])

  const slides = useMemo(() => {
    const list: { key: string; render: () => React.ReactNode }[] = []

    list.push({
      key: 'intro',
      render: () => (
        <div className="wrapped-card wrapped-card--hero">
          <p className="wrapped-eyebrow">Tu Wrapped</p>
          <h1 className="wrapped-big-number">{formatMinutes(stats.totalMs)}</h1>
          <p className="wrapped-sub">escuchando música {period === 'all' ? 'en total' : 'en los últimos 30 días'}</p>
        </div>
      ),
    })

    if (stats.topArtists[0]) {
      list.push({
        key: 'artist',
        render: () => (
          <div className="wrapped-card">
            <p className="wrapped-eyebrow">Tu artista #1</p>
            {stats.topArtists[0]!.thumb && <CachedImg src={stats.topArtists[0]!.thumb} alt="" className="wrapped-art wrapped-art--round" />}
            <h2 className="wrapped-title">{stats.topArtists[0]!.name}</h2>
            <p className="wrapped-sub">{formatMinutes(stats.topArtists[0]!.ms)} escuchadas</p>
            {stats.topArtists.length > 1 && (
              <ol className="wrapped-list">
                {stats.topArtists.slice(1, 5).map((a, i) => (
                  <li key={a.name}>
                    <span className="wrapped-list-rank">{i + 2}</span>
                    {a.name}
                  </li>
                ))}
              </ol>
            )}
          </div>
        ),
      })
    }

    if (stats.topSongs[0]) {
      list.push({
        key: 'song',
        render: () => (
          <div className="wrapped-card">
            <p className="wrapped-eyebrow">Tu canción #1</p>
            {stats.topSongs[0]!.albumArtUrl && <CachedImg src={stats.topSongs[0]!.albumArtUrl} alt="" className="wrapped-art" />}
            <h2 className="wrapped-title">{stats.topSongs[0]!.title}</h2>
            <p className="wrapped-sub">{stats.topSongs[0]!.artist}</p>
            <ol className="wrapped-list">
              {stats.topSongs.slice(1, 5).map((s, i) => (
                <li key={s.id}>
                  <span className="wrapped-list-rank">{i + 2}</span>
                  {s.title} <span className="wrapped-list-sub">— {s.artist}</span>
                </li>
              ))}
            </ol>
          </div>
        ),
      })
    }

    if (stats.mostRepeatedSong) {
      list.push({
        key: 'repeat',
        render: () => (
          <div className="wrapped-card">
            <Music2 size={28} className="wrapped-icon" />
            <p className="wrapped-eyebrow">La que más repetiste</p>
            <h2 className="wrapped-title">{stats.mostRepeatedSong!.title}</h2>
            <p className="wrapped-sub">{stats.mostRepeatedSong!.count} veces · {stats.mostRepeatedSong!.artist}</p>
          </div>
        ),
      })
    }

    if (stats.topGenres.length > 0) {
      list.push({
        key: 'personality',
        render: () => (
          <div className="wrapped-card">
            <Disc3 size={28} className="wrapped-icon" />
            <p className="wrapped-eyebrow">Tu personalidad musical</p>
            <h2 className="wrapped-title">{stats.personality}</h2>
            <p className="wrapped-sub">Géneros favoritos: {stats.topGenres.join(', ')}</p>
          </div>
        ),
      })
    }

    list.push({
      key: 'streak',
      render: () => (
        <div className="wrapped-card">
          <Flame size={28} className="wrapped-icon" />
          <p className="wrapped-eyebrow">Racha actual</p>
          <h2 className="wrapped-title">{stats.streak} {stats.streak === 1 ? 'día' : 'días'}</h2>
          {stats.firstListenAt && (
            <p className="wrapped-sub">
              <Clock size={13} /> Escuchando en XFY desde {new Date(stats.firstListenAt).toLocaleDateString('es-AR', { month: 'long', year: 'numeric' })}
            </p>
          )}
        </div>
      ),
    })

    return list
  }, [stats, period])

  const current = slides[Math.min(slide, slides.length - 1)]

  const goNext = () => setSlide((s) => Math.min(slides.length - 1, s + 1))
  const goPrev = () => setSlide((s) => Math.max(0, s - 1))

  const handleShare = async () => {
    const text = `Mi Wrapped en XFY: ${formatMinutes(stats.totalMs)} escuchando música, mi artista #1 fue ${stats.topArtists[0]?.name || '—'} 🎧`
    try {
      if (navigator.share) {
        await navigator.share({ text })
      } else {
        await navigator.clipboard.writeText(text)
        toast.success('Copiado al portapapeles')
      }
    } catch {
      // el usuario canceló el share sheet — no es un error
    }
  }

  return (
    <div className="wrapped-page">
      <button type="button" className="wrapped-close" onClick={() => smartGoBack(navigate, '/')} aria-label="Cerrar">
        <X size={20} />
      </button>

      <div className="wrapped-period-toggle">
        {PERIODS.map((p) => (
          <button
            key={p.id}
            type="button"
            className={`wrapped-period-btn${period === p.id ? ' active' : ''}`}
            onClick={() => { setPeriod(p.id); setSlide(0) }}
          >
            {p.label}
          </button>
        ))}
      </div>

      <div className="wrapped-progress-row">
        {slides.map((s, i) => (
          <span key={s.key} className={`wrapped-progress-dot${i <= slide ? ' filled' : ''}`} />
        ))}
      </div>

      <div className="wrapped-stage">
        <AnimatePresence mode="wait" custom={slide}>
          {current && (
            <motion.div
              key={current.key}
              className="wrapped-slide"
              initial={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.94, y: 12 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.96, y: -10 }}
              transition={{ type: 'spring', stiffness: 300, damping: 28 }}
            >
              {current.render()}
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <div className="wrapped-nav">
        <button type="button" className="wrapped-nav-btn" onClick={goPrev} disabled={slide === 0} aria-label="Anterior">
          <ArrowLeft size={18} />
        </button>
        <button type="button" className="wrapped-share-btn" onClick={handleShare}>
          <Share2 size={16} />
          Compartir
        </button>
        <button type="button" className="wrapped-nav-btn" onClick={goNext} disabled={slide === slides.length - 1} aria-label="Siguiente">
          <ArrowRight size={18} />
        </button>
      </div>
    </div>
  )
}
