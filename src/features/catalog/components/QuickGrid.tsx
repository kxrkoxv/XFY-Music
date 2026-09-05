import { memo } from 'react'
import { motion, useReducedMotion } from 'motion/react'
import { Play } from 'lucide-react'
import CachedImg from '@shared/components/CachedImg'
import ArtistLinks from '@shared/components/ArtistLinks'
import Tilt3D from '@shared/components/Tilt3D'
import { useAutoHideScrollbar } from '@shared/lib/useAutoHideScrollbar'
import { warmYouTubeAudio } from '@features/player/lib/ytblob'
import type { SongLike } from '@shared/lib/songIdentity'

type WarmableSong = SongLike & { source?: string | null }

function warmIfYouTube(song: WarmableSong): void {
  if (song.source === 'youtube' && (song.videoId || song.id)) {
    warmYouTubeAudio((song.videoId || song.id) as string | null | undefined)
  }
}

interface QuickGridCardProps {
  song: SongLike
  index: number
  onPlay: (song: SongLike) => void
  showBadge?: boolean
  reduceMotion: boolean | null
}

// MEJORA de performance: tarjeta extraída y memoizada, igual criterio que
// SongCard.tsx — recibe la MISMA referencia de `onPlay` para las N tarjetas
// (ver QuickGrid más abajo) en vez de una arrow function nueva por canción
// en cada .map(), así React.memo evita re-renderizar las tarjetas ya
// pintadas cuando el resto de la página cambia de estado.
const QuickGridCard = memo(function QuickGridCard({ song, index, onPlay, showBadge, reduceMotion }: QuickGridCardProps) {
  const handlePlay = () => onPlay(song)
  return (
    <motion.div
      className="qg-card"
      role="button"
      tabIndex={0}
      onClick={handlePlay}
      onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && handlePlay()}
      onPointerDown={() => warmIfYouTube(song)}
      onPointerEnter={() => warmIfYouTube(song)}
      initial={reduceMotion ? { opacity: 0 } : { opacity: 0, x: 24 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ type: 'spring', stiffness: 340, damping: 32, delay: index * 0.05 }}
      whileTap={{ scale: 0.96 }}
    >
      <Tilt3D className="qg-card-tilt" max={9} lift={14}>
        <CachedImg song={song} alt="" className="qg-card-img" />
        <div className="qg-card-scrim" aria-hidden="true" />
        {showBadge && (
          <div className="qg-badge" aria-hidden="true">
            <span className="qg-badge-num">{index + 1}</span>
          </div>
        )}
        <div className="qg-card-play" aria-hidden="true">
          <Play size={15} fill="currentColor" />
        </div>
        <div className="qg-card-info">
          <p className="qg-card-title" title={song.title}>{song.title}</p>
          <ArtistLinks song={song} className="qg-card-artist" />
        </div>
      </Tilt3D>
    </motion.div>
  )
})

interface QuickGridProps {
  songs?: SongLike[]
  onPlay: (song: SongLike) => void
  title?: string
  kicker?: string
  showBadge?: boolean
  action?: string
  onAction?: () => void
}

/**
 * "Escuchado recientemente" como tira horizontal de tarjetas grandes con
 * la carátula a pantalla completa y título/artista superpuestos sobre un
 * degradé — el mismo lenguaje que el "Recently Played" de referencia
 * (carátula inmersiva de punta a punta, sin marco alrededor), en vez de
 * la fila de íconos chicos que había antes.
 */
export default function QuickGrid({ songs = [], onPlay, title, kicker, showBadge, action, onAction }: QuickGridProps) {
  const reduceMotion = useReducedMotion()
  const scrollRef = useAutoHideScrollbar<HTMLDivElement>()
  if (!songs.length) return null

  return (
    <motion.section
      className="qg-section"
      initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 22 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '0px 0px -80px 0px' }}
      transition={{ type: 'spring', stiffness: 260, damping: 30 }}
    >
      {(title || kicker) && (
        <div className="qg-header">
          {title && <h2 className="home-section-title">{title}</h2>}
          {kicker && <p className="qg-kicker">{kicker}</p>}
          {action && onAction && (
            <button type="button" className="qg-action" onClick={onAction}>
              {action}
            </button>
          )}
        </div>
      )}
      <div className="qg-row custom-scroll custom-scroll--autohide" ref={scrollRef}>
        {songs.slice(0, 8).map((song, i) => (
          <QuickGridCard
            key={song.id}
            song={song}
            index={i}
            onPlay={onPlay}
            showBadge={showBadge}
            reduceMotion={reduceMotion}
          />
        ))}
      </div>
    </motion.section>
  )
}
