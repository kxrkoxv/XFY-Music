import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Search, Mic2, Loader2 } from 'lucide-react'
import { motion, AnimatePresence, useReducedMotion } from 'motion/react'
import { usePlayerStore } from '@features/player'
import { getFavoriteSongs, useAuthStore } from '@features/auth'
import { usePlaylistsStore } from '@features/playlists'
import { resolveArtistEntries } from '@shared/lib/artistNames'
import { lookupArtistPhoto, readArtistPhoto } from '@features/artists/lib/artists'
import { searchArtists as searchArtistsAPI } from '@services/api/ytmusic'
import type { ArtistResult } from '@/types/models'
import CachedImg from '@shared/components/CachedImg'
import Sidebar from '@shared/components/Sidebar'
import useCanHover from '@shared/lib/useCanHover'
import { EASE_OUT } from '@shared/lib/motionTokens'
import type { SongLike } from '@shared/lib/songIdentity'
import './ArtistsPage.css'

/**
 * Foto de la card del artista en la grilla. Antes esta grilla usaba
 * `song.albumArtUrl` (la carátula del álbum de UNA canción cualquiera del
 * artista) como foto — por eso acá aparecía una imagen y al entrar a
 * ArtistPage aparecía otra completamente distinta (esa sí, la foto real
 * del artista vía lookupArtistPhoto). Ahora las dos pantallas resuelven la
 * foto con la MISMA función cacheada, así que siempre coinciden.
 * `fallbackThumb` (la carátula de álbum de antes) se usa solo como
 * placeholder instantáneo mientras se resuelve la foto real, para no
 * mostrar la card vacía en la primera visita.
 */
interface ArtistCardArtProps {
  name: string
  fallbackThumb?: string | null
}

function ArtistCardArt({ name, fallbackThumb }: ArtistCardArtProps) {
  const [photo, setPhoto] = useState<string | null>(() => readArtistPhoto(name) || fallbackThumb || null)

  const prevKeyRef = useRef(`${name}|${fallbackThumb}`)
  useEffect(() => {
    const key = `${name}|${fallbackThumb}`
    if (prevKeyRef.current !== key) {
      setPhoto(readArtistPhoto(name) || fallbackThumb || null)
      prevKeyRef.current = key
    }
    let active = true
    lookupArtistPhoto(name).then((url) => {
      if (active && url) setPhoto(url)
    })
    return () => {
      active = false
    }
  }, [name, fallbackThumb])

  if (!photo) {
    return (
      <div className="artists-card-fallback">
        <Mic2 size={28} strokeWidth={1.5} />
      </div>
    )
  }

  return <CachedImg src={photo} alt="" title={name} />
}

/**
 * Lista de artistas de la biblioteca — no de un artista puntual (eso es
 * ArtistPage.jsx). Se arma a partir de las mismas fuentes que ya usa
 * ArtistPage para "Ya tenés de este artista": favoritos, reproducidas
 * recientemente y todas las playlists, agrupadas por artista.
 */

/** Un artista agrupado en la biblioteca, con su conteo y miniatura. */
interface LibraryArtist {
  name: string
  artistId: string | null
  count: number
  thumbUrl: string | null
}

/** Tarjeta de artista animada, compartida entre biblioteca/búsqueda local/resultados de catálogo. */
interface ArtistTileProps {
  name: string
  thumbUrl?: string | null
  countLabel?: string
  index: number
  onClick: () => void
}

function ArtistTile({ name, thumbUrl, countLabel, index, onClick }: ArtistTileProps) {
  const reduceMotion = useReducedMotion()
  const canHover = useCanHover()
  return (
    <motion.button
      className="artists-card"
      type="button"
      onClick={onClick}
      initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 14, scale: 0.95 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ type: 'spring', stiffness: 340, damping: 30, delay: Math.min(index * 0.035, 0.35) }}
      whileHover={canHover ? { y: -4 } : undefined}
      whileTap={{ scale: 0.96 }}
    >
      <div className="artists-card-art">
        <ArtistCardArt name={name} fallbackThumb={thumbUrl} />
      </div>
      <p className="artists-card-name">{name}</p>
      {countLabel && <p className="artists-card-count">{countLabel}</p>}
    </motion.button>
  )
}

export default function ArtistsPage() {
  const navigate = useNavigate()
  const currentUser = useAuthStore((s) => s.currentUser)
  const getRecentlyPlayed = usePlayerStore((s) => s.getRecentlyPlayed)
  const playlists = usePlaylistsStore((s) => s.playlists)
  const [query, setQuery] = useState('')
  const [catalogQuery, setCatalogQuery] = useState('')
  const [catalogResults, setCatalogResults] = useState<ArtistResult[]>([])
  const [catalogLoading, setCatalogLoading] = useState(false)
  const catalogDebounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const artists = useMemo(() => {
    const bySlug = new Map<string, LibraryArtist>()

    const consider = (song: SongLike) => {
      for (const { name, artistId } of resolveArtistEntries(song)) {
        const slug = name.toLowerCase().trim()
        if (!slug) continue
        const existing = bySlug.get(slug)
        if (existing) {
          existing.count += 1
          if (!existing.artistId && artistId) existing.artistId = artistId
          if (!existing.thumbUrl && song.albumArtUrl) existing.thumbUrl = song.albumArtUrl
        } else {
          bySlug.set(slug, {
            name,
            artistId: artistId || null,
            count: 1,
            thumbUrl: song.albumArtUrl || null,
          })
        }
      }
    }

    getFavoriteSongs(currentUser).forEach(consider)
    getRecentlyPlayed().forEach(consider)
    playlists.forEach((p) => (p.songs || []).forEach(consider))

    return [...bySlug.values()].sort((a, b) => a.name.localeCompare(b.name, 'es'))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentUser, playlists])

  const filteredArtists = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return artists
    return artists.filter((a) => a.name.toLowerCase().includes(q))
  }, [artists, query])

  // Busca en el catálogo (vía ytmusic) además de filtrar la biblioteca local,
  // para que el buscador encuentre artistas que el usuario todavía no tiene
  // guardados. Debounced para no disparar un fetch en cada tecla.
  useEffect(() => {
    const q = query.trim()
    if (q.length < 2) {
      if (catalogDebounceRef.current) clearTimeout(catalogDebounceRef.current)
      setCatalogQuery('')
      setCatalogResults([])
      setCatalogLoading(false)
      return
    }

    if (catalogDebounceRef.current) clearTimeout(catalogDebounceRef.current)
    setCatalogLoading(true)
    catalogDebounceRef.current = setTimeout(() => {
      setCatalogQuery(q)
    }, 350)

    return () => {
      if (catalogDebounceRef.current) clearTimeout(catalogDebounceRef.current)
    }
  }, [query])

  useEffect(() => {
    if (!catalogQuery) return
    let active = true
    setCatalogLoading(true)
    searchArtistsAPI(catalogQuery, 16)
      .then((results) => {
        if (active) setCatalogResults(results || [])
      })
      .catch(() => {
        if (active) setCatalogResults([])
      })
      .finally(() => {
        if (active) setCatalogLoading(false)
      })
    return () => {
      active = false
    }
  }, [catalogQuery])

  // Evita duplicar en "Resultados" un artista que ya aparece en la biblioteca.
  const librarySlugs = useMemo(() => new Set(artists.map((a) => a.name.toLowerCase().trim())), [artists])
  const searchResults = useMemo(
    () => catalogResults.filter((r) => !librarySlugs.has(r.name.toLowerCase().trim())),
    [catalogResults, librarySlugs],
  )

  const isSearching = query.trim().length >= 2

  const openArtist = (artist: LibraryArtist) => {
    const params = artist.artistId ? `?id=${encodeURIComponent(artist.artistId)}` : ''
    navigate(`/artist/${encodeURIComponent(artist.name)}${params}`)
  }

  const openCatalogArtist = (artist: ArtistResult) => {
    const params = artist.artistId ? `?id=${encodeURIComponent(artist.artistId)}` : ''
    navigate(`/artist/${encodeURIComponent(artist.name)}${params}`)
  }

  const reduceMotion = useReducedMotion()

  return (
    <div className="artists-page">
      <Sidebar />

      <motion.header
        className="artists-header"
        initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35, ease: EASE_OUT }}
      >
        <h1 className="home-section-title">Artistas</h1>
        <p className="artists-subtitle">
          {artists.length === 0
            ? 'Todavía no tenés artistas en tu biblioteca'
            : `${artists.length} artista${artists.length === 1 ? '' : 's'} en tu biblioteca`}
        </p>
      </motion.header>

      <motion.div
        className="artists-search"
        initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35, ease: EASE_OUT, delay: 0.05 }}
      >
        <Search size={16} />
        <input
          type="text"
          placeholder="Buscar artista"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {catalogLoading && <Loader2 size={16} className="artists-search-spinner" />}
      </motion.div>

      <AnimatePresence mode="wait">
        {!isSearching && artists.length === 0 && (
          <motion.p
            key="empty"
            className="home-empty"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
          >
            Marcá canciones como favoritas, reproducilas o agregalas a una playlist y sus artistas van a aparecer acá.
          </motion.p>
        )}

        {!isSearching && artists.length > 0 && (
          <motion.div key="library-grid" className="artists-grid" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }}>
            {artists.map((artist, index) => (
              <ArtistTile
                key={artist.name}
                name={artist.name}
                thumbUrl={artist.thumbUrl}
                countLabel={`${artist.count} canción${artist.count === 1 ? '' : 'es'}`}
                index={index}
                onClick={() => openArtist(artist)}
              />
            ))}
          </motion.div>
        )}

        {isSearching && (
          <motion.div key="search-results" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }}>
            {filteredArtists.length > 0 && (
              <section className="artists-search-section">
                <h2 className="artists-search-heading">En tu biblioteca</h2>
                <div className="artists-grid">
                  {filteredArtists.map((artist, index) => (
                    <ArtistTile
                      key={artist.name}
                      name={artist.name}
                      thumbUrl={artist.thumbUrl}
                      countLabel={`${artist.count} canción${artist.count === 1 ? '' : 'es'}`}
                      index={index}
                      onClick={() => openArtist(artist)}
                    />
                  ))}
                </div>
              </section>
            )}

            <section className="artists-search-section">
              <h2 className="artists-search-heading">Resultados</h2>
              {searchResults.length > 0 ? (
                <div className="artists-grid">
                  {searchResults.map((artist, index) => (
                    <ArtistTile
                      key={artist.artistId}
                      name={artist.name}
                      thumbUrl={artist.thumbUrl}
                      index={index}
                      onClick={() => openCatalogArtist(artist)}
                    />
                  ))}
                </div>
              ) : catalogLoading ? (
                <p className="home-empty">Buscando "{query}"…</p>
              ) : filteredArtists.length === 0 ? (
                <p className="home-empty">No encontramos artistas que coincidan con "{query}".</p>
              ) : null}
            </section>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
