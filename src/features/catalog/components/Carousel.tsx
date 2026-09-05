import type { ReactNode } from 'react'
import { motion, useReducedMotion } from 'motion/react'
import SongCard from './SongCard'
import { useAutoHideScrollbar } from '@shared/lib/useAutoHideScrollbar'
import type { SongLike } from '@shared/lib/songIdentity'

interface CarouselProps {
  title: string
  kicker?: string
  songs?: SongLike[]
  onPlay: (song: SongLike) => void
  badge?: (song: SongLike, index: number) => ReactNode
  action?: ReactNode
  onAction?: () => void
}

/** Enhanced Carousel with optional kicker subtitle, song badges, and staggered motion animations. */
export default function Carousel({ title, kicker, songs, onPlay, badge, action, onAction }: CarouselProps) {
  const scrollRef = useAutoHideScrollbar<HTMLDivElement>()
  const reduceMotion = useReducedMotion()

  if (!songs || songs.length === 0) return null
  return (
    <motion.section
      className="home-section"
      initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 20 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '-60px' }}
      transition={{ type: 'spring', stiffness: 260, damping: 28 }}
    >
      <div className="home-section-header">
        <div>
          {kicker && <p className="home-section-kicker">{kicker}</p>}
          <h2 className="home-section-title">{title}</h2>
        </div>
        {action && (
          <button className="home-section-action" onClick={onAction}>
            {action}
          </button>
        )}
      </div>
      <div className="home-carousel-row custom-scroll custom-scroll--autohide" ref={scrollRef}>
        {songs.map((song, i) => (
          // `onPlay` se pasa tal cual (misma referencia para las N tarjetas)
          // en vez de envolverlo en una arrow function nueva por canción —
          // eso es lo que le permite a React.memo en SongCard funcionar de
          // verdad (ver comentario en SongCard.tsx).
          <SongCard
            key={song.id}
            song={song}
            index={i}
            onPlay={onPlay}
            badge={badge ? badge(song, i) : undefined}
          />
        ))}
      </div>
    </motion.section>
  )
}
