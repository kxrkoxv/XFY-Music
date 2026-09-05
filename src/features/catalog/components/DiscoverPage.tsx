import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { Heart, Play, Loader2, X } from 'lucide-react'
import { motion, AnimatePresence, useReducedMotion } from 'motion/react'
import { searchSongs, getTrendingTracks } from '@services/api/ytmusic'
import { getGenreTrending } from '@features/catalog/lib/recommendations'
import { usePlayerStore } from '@features/player'
import { useAuthStore, isSongFavorite } from '@features/auth'
import { AddToPlaylistButton } from '@features/playlists'
import Sidebar from '@shared/components/Sidebar'
import BackButton from '@shared/components/BackButton'
import CachedImg from '@shared/components/CachedImg'
import ArtistLinks from '@shared/components/ArtistLinks'
import useCanHover from '@shared/lib/useCanHover'
import { EASE_OUT } from '@shared/lib/motionTokens'
import type { SongLike } from '@shared/lib/songIdentity'
import './DiscoverPage.css'

// Grid de géneros/moods como vista inicial de "Descubre" — el gap real que
// esta página tenía frente al tab "Explorar" de Spotify/Apple Music: antes
// esto era solo buscador + trending, sin forma de navegar por género salvo
// escribiendo el nombre a mano. getGenreTrending(genre) ya existía y ya
// funcionaba (lo usa "Hot en {género}" del Home) — acá solo se expone como
// navegación de primer nivel, sin inventar ningún endpoint nuevo.
const GENRE_TILES: { id: string; gradient: string }[] = [
  { id: 'Pop', gradient: 'linear-gradient(135deg, #ec4899, #7c3aed)' },
  { id: 'Reggaetón', gradient: 'linear-gradient(135deg, #f97316, #db2777)' },
  { id: 'Hip-Hop', gradient: 'linear-gradient(135deg, #6d28d9, #18181b)' },
  { id: 'Rock', gradient: 'linear-gradient(135deg, #dc2626, #27272a)' },
  { id: 'Electrónica', gradient: 'linear-gradient(135deg, #06b6d4, #4338ca)' },
  { id: 'R&B', gradient: 'linear-gradient(135deg, #a21caf, #831843)' },
  { id: 'Indie', gradient: 'linear-gradient(135deg, #14b8a6, #166534)' },
  { id: 'Trap', gradient: 'linear-gradient(135deg, #3f3f46, #6d28d9)' },
  { id: 'Salsa', gradient: 'linear-gradient(135deg, #f59e0b, #b91c1c)' },
  { id: 'Jazz', gradient: 'linear-gradient(135deg, #92400e, #ca8a04)' },
  { id: 'Lo-Fi', gradient: 'linear-gradient(135deg, #818cf8, #c4b5fd)' },
  { id: 'K-Pop', gradient: 'linear-gradient(135deg, #f472b6, #8b5cf6)' },
]

export default function DiscoverPage() {
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  // MEJORA de performance: `usePlayerStore()` sin selector se suscribe al
  // store COMPLETO del reproductor — como esta página solo necesita la
  // acción `playSongRadio` (una referencia estable, no cambia entre
  // renders), pero sin selector React la re-renderiza en CADA tick de
  // `currentTime` (varias veces por segundo mientras suena una canción) y
  // ante cualquier otro cambio de estado del reproductor, aunque nada de
  // eso se use acá. Con selector, esta página deja de re-renderizarse por
  // reproducción en curso — solo lo hace por sus propios estados (tracks,
  // loading, etc.).
  const playSongRadio = usePlayerStore((s) => s.playSongRadio)
  const { currentUser, toggleFavorite } = useAuthStore()
  const [tracks, setTracks] = useState<SongLike[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState(() => searchParams.get('q') || '')
  const [genre, setGenre] = useState<string | null>(null)

  // Debounce search input by 350ms to minimize API calls, with automatic retry for transient errors.
  useEffect(() => {
    let mounted = true
    let retried = false
    let retryTimer: ReturnType<typeof setTimeout> | undefined = undefined
    setLoading(true)
    setError(null)

    const trimmed = query.trim()
    // Sync search query to URL for shareability and history.
    setSearchParams(trimmed ? { q: trimmed } : {}, { replace: true })

    const run = () => {
      // Una búsqueda de texto siempre gana; si no hay búsqueda, se navega
      // por género (tile elegido) o se cae al trending general de siempre.
      const task = trimmed ? searchSongs(trimmed) : genre ? getGenreTrending(genre) : getTrendingTracks()
      task
        .then((result) => {
          if (!mounted) return
          setTracks(result)
          setLoading(false)
          setError(null)
        })
        .catch((e) => {
          if (!mounted) return
          const msg = String(e.message || e)
          const transient = /429|500|502|503|504/.test(msg)
          if (transient && !retried) {
            retried = true
            retryTimer = setTimeout(() => mounted && run(), 1200)
            return
          }
          setError(msg)
          setTracks([])
          setLoading(false)
        })
    }

    // Skip debounce for genre/trending loads — solo la búsqueda de texto
    // espera a que el usuario deje de tipear.
    const delay = trimmed ? 350 : 0
    const timer = setTimeout(run, delay)

    return () => {
      mounted = false
      clearTimeout(timer)
      clearTimeout(retryTimer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, genre])

  const handlePlay = (track: SongLike) => {
    // playSongRadio, no playQueueAt: al elegir un resultado puntual ya no
    // seguimos ofreciendo el resto de la lista (coincidencias de texto o
    // del mismo género) como si fuera la cola — pasamos a una radio armada
    // con el artista de lo que realmente elegiste escuchar. `tracks` (el
    // resto de esta lista) se aprovecha como contexto gratis por si ya
    // trae más temas de ese mismo artista.
    // No se espera la promesa: navegamos ya al reproductor principal
    // (el set() síncrono de playSongRadio deja el estado listo antes de
    // este navigate) para que nunca se alcance a pintar la mini barra acá.
    void playSongRadio(track, tracks).catch(() => {})
    navigate('/player')
  }

  const handleSelectGenre = (id: string) => {
    setGenre((prev) => (prev === id ? null : id))
  }

  const resultsTitle = query.trim() ? null : genre ? `Hot en ${genre}` : 'Tendencias ahora'
  const reduceMotion = useReducedMotion()
  const canHover = useCanHover()

  return (
    <div className="discover-page">
      <Sidebar />

      <motion.header
        className="discover-header"
        initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35, ease: EASE_OUT }}
      >
        <BackButton />
        <div>
          <p className="home-section-kicker">Descubre</p>
          <h1 className="discover-title">Descubre</h1>
          <p className="discover-subtitle">Millones de canciones, siempre a mano.</p>
        </div>
      </motion.header>

      <motion.div
        className="discover-search"
        initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35, ease: EASE_OUT, delay: 0.05 }}
      >
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Buscar canciones o artistas…"
          aria-label="Buscar música"
          autoFocus
        />
      </motion.div>

      {/* Grid de géneros/moods: se muestra siempre que no haya una búsqueda
          de texto activa, para poder navegar o cambiar de género en
          cualquier momento — no solo como pantalla "vacía" inicial. */}
      {!query.trim() && (
        <div className="discover-genre-grid" role="list" aria-label="Explorar por género">
          {GENRE_TILES.map((tile, index) => (
            <motion.button
              key={tile.id}
              type="button"
              role="listitem"
              aria-pressed={genre === tile.id}
              className={`discover-genre-tile${genre === tile.id ? ' active' : ''}`}
              style={{ background: tile.gradient }}
              onClick={() => handleSelectGenre(tile.id)}
              initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 12, scale: 0.94 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              transition={{ type: 'spring', stiffness: 340, damping: 30, delay: Math.min(index * 0.03, 0.3) }}
              whileHover={canHover ? { scale: 1.04 } : undefined}
              whileTap={{ scale: 0.94 }}
            >
              {tile.id}
            </motion.button>
          ))}
        </div>
      )}

      <main className="discover-content">
        {resultsTitle && (
          <div className="discover-results-header">
            <h2 className="home-section-title">{resultsTitle}</h2>
            {genre && (
              <motion.button
                type="button"
                className="discover-genre-clear"
                onClick={() => setGenre(null)}
                whileHover={canHover ? { scale: 1.05 } : undefined}
                whileTap={{ scale: 0.92 }}
              >
                <X size={13} />
                Quitar filtro
              </motion.button>
            )}
          </div>
        )}

        <AnimatePresence mode="wait">
          {loading ? (
            <motion.div
              key="loading"
              className="discover-loading"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
            >
              <Loader2 size={20} className="discover-spin" />
              <span>Cargando…</span>
            </motion.div>
          ) : error ? (
            <motion.p
              key="error"
              className="home-empty"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
            >
              Ocurrió un problema buscando. Probá de nuevo en un momento.
            </motion.p>
          ) : tracks.length === 0 ? (
            <motion.p
              key="empty"
              className="home-empty"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
            >
              No se encontraron canciones. Probá con otro término.
            </motion.p>
          ) : (
            <motion.div
              key={`grid-${query}-${genre ?? ''}`}
              className="discover-grid"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
            >
              {tracks.map((track, index) => {
                const isFavorite = isSongFavorite(currentUser, track.id)
                return (
                  <motion.div
                    key={track.id}
                    className="discover-card"
                    onClick={() => handlePlay(track)}
                    initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 14, scale: 0.97 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    transition={{ type: 'spring', stiffness: 340, damping: 30, delay: Math.min(index * 0.03, 0.3) }}
                    whileHover={canHover ? { y: -4 } : undefined}
                    whileTap={{ scale: 0.97 }}
                  >
                    <div className="discover-card-art">
                      {track.albumArtUrl ? <CachedImg song={track} alt="" /> : <div className="discover-card-art-placeholder" />}
                      <motion.button className="discover-card-play" tabIndex={-1} aria-hidden="true" whileTap={{ scale: 0.85 }}>
                        <Play size={18} fill="currentColor" />
                      </motion.button>
                    </div>
                    <div className="discover-card-info">
                      <p className="song-card-title" title={track.title}>
                        {track.title}
                      </p>
                      <ArtistLinks song={track} className="song-card-artist discover-card-artist" />
                    </div>
                    <div className="discover-card-actions">
                      <motion.button
                        className="discover-card-fav"
                        aria-label={isFavorite ? 'Quitar de favoritas' : 'Añadir a favoritas'}
                        onClick={(e) => {
                          e.stopPropagation()
                          toggleFavorite(track)
                        }}
                        whileTap={{ scale: 0.8 }}
                      >
                        <Heart size={15} fill={isFavorite ? 'var(--accent-strong)' : 'none'} color={isFavorite ? 'var(--accent-strong)' : 'currentColor'} />
                      </motion.button>
                      <div onClick={(e) => e.stopPropagation()}>
                        <AddToPlaylistButton song={track} />
                      </div>
                    </div>
                  </motion.div>
                )
              })}
            </motion.div>
          )}
        </AnimatePresence>
      </main>
    </div>
  )
}
