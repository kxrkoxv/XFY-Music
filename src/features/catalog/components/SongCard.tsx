import type { ReactNode } from 'react'
import { memo } from 'react'
import { motion, useReducedMotion } from 'motion/react'
import { Play } from 'lucide-react'
import CachedImg from '@shared/components/CachedImg'
import ArtistLinks from '@shared/components/ArtistLinks'
import Tilt3D from '@shared/components/Tilt3D'
import useCanHover from '@shared/lib/useCanHover'
import { warmYouTubeAudio } from '@features/player/lib/ytblob'
import type { SongLike } from '@shared/lib/songIdentity'

type WarmableSong = SongLike & { source?: string | null }

function warmIfYouTube(song: WarmableSong): void {
  if (song.source === 'youtube' && (song.videoId || song.id)) {
    warmYouTubeAudio((song.videoId || song.id) as string | null | undefined)
  }
}

interface SongCardProps {
  song: SongLike
  onPlay: (song: SongLike) => void
  badge?: ReactNode
  /** Posición dentro del carrusel — determina el delay del stagger de entrada. */
  index?: number
}

// Adelanta el cacheo en Blob (extracción server-side + upload al CDN)
// ANTES de que el usuario termine de soltar el click/tap: dispara POST
// /api/ytcache en background. Se dispara en pointerdown/hover (más
// temprano que click) y es fire-and-forget: si el usuario nunca llega a
// soltar el tap, no pasa nada; si sí, con suerte el blob ya está listo
// (o en camino) cuando usePlayerStore reproduzca la canción de verdad.

// MEJORA de performance: memoizado + `onPlay` recibe ahora la MISMA
// referencia que le llegó a Carousel/QuickGrid en vez de una función
// nueva creada por cada tarjeta en cada .map() (ver Carousel.tsx). Antes
// eso invalidaba cualquier memo: React.memo comparaba props y `onPlay`
// SIEMPRE era una función distinta, así que cada carrusel completo se
// volvía a renderizar entero ante cualquier cambio de estado de la
// página (tipear en el buscador, cambiar de país en las charts, etc.),
// aunque ninguna canción visible hubiera cambiado.
function SongCard({ song, onPlay, badge, index = 0 }: SongCardProps) {
  const reduceMotion = useReducedMotion()
  const canHover = useCanHover()
  const handlePlay = () => onPlay(song)

  return (
    <motion.div
      className="song-card"
      role="button"
      tabIndex={0}
      onClick={handlePlay}
      onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && handlePlay()}
      onPointerDown={() => warmIfYouTube(song)}
      onPointerEnter={() => warmIfYouTube(song)}
      initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 16, scale: 0.96 }}
      whileInView={{ opacity: 1, y: 0, scale: 1 }}
      viewport={{ once: true, margin: '-40px', amount: 0.4 }}
      transition={{ type: 'spring', stiffness: 340, damping: 30, delay: Math.min(index * 0.045, 0.4) }}
      whileHover={canHover ? { y: -4 } : undefined}
      whileTap={{ scale: 0.95 }}
    >
      <div className="song-card-art">
        <Tilt3D className="song-card-art-tilt" max={10} lift={16}>
          <CachedImg song={song} alt={song.title} title={song.title} />
        </Tilt3D>
        <motion.button
          className="song-card-play"
          tabIndex={-1}
          aria-hidden="true"
          whileTap={{ scale: 0.85 }}
        >
          <Play size={16} fill="currentColor" />
        </motion.button>
        {badge != null && <span className="song-card-badge">{badge}</span>}
      </div>
      <p className="song-card-title" title={song.title}>
        {song.title}
      </p>
      <ArtistLinks song={song} className="song-card-artist" />
    </motion.div>
  )
}

export default memo(SongCard)
