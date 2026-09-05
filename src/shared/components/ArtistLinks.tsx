import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { resolveArtistEntries } from '@shared/lib/artistNames'
import type { ArtistEntry, SongLike } from '@shared/lib/artistNames'
import './ArtistLinks.css'

/**
 * Renderiza el/los artista(s) de una canción como nombres individuales
 * clickeables (p. ej. "Drake & Yebba" -> "Drake" y "Yebba" navegables por
 * separado), en vez de un solo bloque de texto plano. Cada nombre navega
 * a su propia página de artista al pasar el mouse por encima (cursor
 * pointer + subrayado) y al hacer click, sin depender de que el usuario
 * haga click exactamente sobre el nombre combinado.
 */
interface ArtistLinksProps {
  song?: SongLike
  className?: string
  title?: string
}

export default function ArtistLinks({ song, className = '', title }: ArtistLinksProps) {
  const navigate = useNavigate()
  const entries = resolveArtistEntries(song)

  if (entries.length === 0) return null

  const go = (e: ReactMouseEvent<HTMLElement> | ReactKeyboardEvent<HTMLElement>, entry: ArtistEntry) => {
    e.stopPropagation()
    const path = entry.artistId
      ? `/artist/${encodeURIComponent(entry.name)}?id=${encodeURIComponent(entry.artistId)}`
      : `/artist/${encodeURIComponent(entry.name)}`
    navigate(path)
  }

  return (
    <p className={`artist-links ${className}`} title={title || entries.map((e) => e.name).join(', ')}>
      {entries.map((entry, i) => (
        <span key={`${entry.name}-${i}`}>
          <span
            className="artist-links-name"
            role="link"
            tabIndex={0}
            onClick={(e) => go(e, entry)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') go(e, entry)
            }}
          >
            {entry.name}
          </span>
          {i < entries.length - 2 && <span className="artist-links-sep">, </span>}
          {i === entries.length - 2 && <span className="artist-links-sep"> &amp; </span>}
        </span>
      ))}
    </p>
  )
}
