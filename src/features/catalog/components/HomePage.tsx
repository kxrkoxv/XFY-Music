import { useEffect, useRef, useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { Menu } from '@base-ui/react/menu'
import { Search, LogOut, Compass, Loader2, Mic2, TrendingUp, UserRound, Sparkle, Users2 } from 'lucide-react'
import { motion, AnimatePresence, useReducedMotion } from 'motion/react'
import { usePlayerStore } from '@features/player'
import { useAuthStore, getFavoriteSongs } from '@features/auth'
import { getTrendingTracks, searchSongs, searchArtists } from '@services/api/ytmusic'
import {
  getTrendingTracks as getAppleCharts,
  APPLE_CHART_COUNTRIES,
  getPreferredChartCountry,
  setPreferredChartCountry,
} from '@services/api/appleCharts'
import { getRecommendations, getTopArtistRecommendations, getGenreTrending, getPersonalizedSeeds, getDaylistMeta, getDaylistSongs } from '@features/catalog/lib/recommendations'
import { getTasteProfile, getTopGenre, getSongAffinityScores, getOnRepeat, getTimeCapsule } from '@shared/lib/metrics'
import { isSameSong } from '@shared/lib/songIdentity'
import QuickGrid from '@features/catalog/components/QuickGrid'
import HeroGreeting from '@features/catalog/components/HeroGreeting'
import Sidebar from '@shared/components/Sidebar'
import CachedImg from '@shared/components/CachedImg'
import { useAutoHideScrollbar } from '@shared/lib/useAutoHideScrollbar'
import type { Song, ArtistResult } from '@/types/models'
import type { SongLike } from '@shared/lib/songIdentity'
import './HomePage.css'

/** Indicador "Buscando…" con tres puntos que rebotan en cascada, en vez del spinner
 * genérico — más liviano y acorde al resto de las micro-animaciones de la app. */
function SearchLoadingIndicator({ reduceMotion }: { reduceMotion: boolean | null }) {
  return (
    <div className="home-search-results-loading">
      <span className="home-search-dots" aria-hidden="true">
        {[0, 1, 2].map((i) => (
          <motion.span
            key={i}
            className="home-search-dot"
            animate={reduceMotion ? undefined : { y: [0, -5, 0], opacity: [0.5, 1, 0.5] }}
            transition={{ duration: 0.9, repeat: Infinity, ease: 'easeInOut', delay: i * 0.15 }}
          />
        ))}
      </span>
      <span>Buscando…</span>
    </div>
  )
}

export default function HomePage() {
  const navigate = useNavigate()
  const reduceMotion = useReducedMotion()
  const [query, setQuery] = useState('')
  const { currentUser, logout } = useAuthStore()
  // MEJORA de performance: mismo problema que en DiscoverPage — sin
  // selector, HomePage (la pantalla más pesada de la app: varios carruseles
  // horizontales) se re-renderizaba en cada tick de reproducción aunque no
  // muestra nada del estado del reproductor, solo llama a estas 3 acciones.
  const playQueueAt = usePlayerStore((s) => s.playQueueAt)
  const playSongRadio = usePlayerStore((s) => s.playSongRadio)
  const getRecentlyPlayed = usePlayerStore((s) => s.getRecentlyPlayed)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const searchWrapRef = useRef<HTMLDivElement>(null)
  const countryRowRef = useAutoHideScrollbar<HTMLDivElement>()

  // --- Search State ---
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchLoading, setSearchLoading] = useState(false)
  const [searchResults, setSearchResults] = useState<{ songs: Song[]; artists: ArtistResult[] }>({
    songs: [],
    artists: [],
  })

  // --- Catalog Sections State ---
  const [trending, setTrending] = useState<Song[]>([])

  const [recommended, setRecommended] = useState<SongLike[]>([])

  const [artistRecs, setArtistRecs] = useState<SongLike[]>([])
  const [topArtist, setTopArtist] = useState<string | null>(null)

  const [genreTracks, setGenreTracks] = useState<SongLike[]>([])
  const [topGenre, setTopGenre] = useState<string | null>(null)

  const [onRepeat, setOnRepeat] = useState<SongLike[]>([])
  const [timeCapsule, setTimeCapsule] = useState<SongLike[]>([])
  const [daylist, setDaylist] = useState<SongLike[]>([])
  const [daylistTitle, setDaylistTitle] = useState<string>('Tu mix del momento')

  const [discoveryTracks, setDiscoveryTracks] = useState<SongLike[]>([])
  const [similarTracks, setSimilarTracks] = useState<SongLike[]>([])
  const [similarSeedTitle, setSimilarSeedTitle] = useState<string | null>(null)
  
  const [userContext, setUserContext] = useState<ReturnType<typeof getPersonalizedSeeds> | null>(null)

  const [appleCharts, setAppleCharts] = useState<Song[]>([])
  const [appleLoading, setAppleLoading] = useState(true)
  const [appleCountry, setAppleCountry] = useState<string>(() => getPreferredChartCountry())

  const recentSongs = getRecentlyPlayed()
  const favoriteSongs = getFavoriteSongs(currentUser)

  // --- Search Debounce ---
  useEffect(() => {
    const trimmed = query.trim()
    if (!trimmed) {
      setSearchResults({ songs: [], artists: [] })
      setSearchLoading(false)
      return
    }
    let mounted = true
    setSearchLoading(true)
    const timer = setTimeout(() => {
      Promise.all([searchSongs(trimmed, 5).catch(() => []), searchArtists(trimmed, 4).catch(() => [])]).then(
        ([songs, artists]) => {
          if (!mounted) return
          setSearchResults({ songs, artists })
          setSearchLoading(false)
        },
      )
    }, 300)
    return () => {
      mounted = false
      clearTimeout(timer)
    }
  }, [query])

  // Close search panel on outside click or Escape.
  useEffect(() => {
    const handlePointerDown = (e: MouseEvent) => {
      if (searchWrapRef.current && !searchWrapRef.current.contains(e.target as Node | null)) setSearchOpen(false)
    }
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSearchOpen(false)
    }
    document.addEventListener('mousedown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('mousedown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [])

  // --- Trending YT Music ---
  useEffect(() => {
    getTrendingTracks(16)
      .then((r) => { setTrending(r) })
      .catch(() => {})
  }, [])

  // --- Apple Charts ---
  useEffect(() => {
    let mounted = true
    setAppleLoading(true)
    getAppleCharts(appleCountry, 20)
      .then((r) => { if (mounted) { setAppleCharts(r); setAppleLoading(false) } })
      .catch(() => { if (mounted) setAppleLoading(false) })
    return () => { mounted = false }
  }, [appleCountry])

  const handleAppleCountryChange = useCallback((country: string) => {
    setAppleCountry((prev) => {
      if (prev === country) return prev
      setPreferredChartCountry(country)
      return country
    })
  }, [])

  // --- For You ---
  useEffect(() => {
    if (favoriteSongs.length === 0 && recentSongs.length === 0) return
    getRecommendations(favoriteSongs, recentSongs)
      .then((r) => { setRecommended(r) })
      .catch(() => {})
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [favoriteSongs.length, recentSongs.length])

  // --- Because you liked X ---
  useEffect(() => {
    const profile = getTasteProfile(1)
    if (!profile.length) return
    const artist = profile[0]
    if (!artist) return
    setTopArtist(artist)
    const known = [...favoriteSongs, ...recentSongs]
    getTopArtistRecommendations(artist, known, 16)
      .then((r) => { setArtistRecs(r) })
      .catch(() => {})
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [favoriteSongs.length, recentSongs.length])

  // --- Hot in [Genre] ---
  useEffect(() => {
    const genres = getTopGenre(1)
    if (!genres.length) return
    const genre = genres[0]
    if (!genre) return
    setTopGenre(genre)
    getGenreTrending(genre, 16)
      .then((r) => { setGenreTracks(r) })
      .catch(() => {})
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // --- Taste Profile & Context ---
  useEffect(() => {
    setUserContext(getPersonalizedSeeds())
  }, [recentSongs.length, favoriteSongs.length])

  // --- On Repeat / Time Capsule (pura data local, sin fetch) ---
  useEffect(() => {
    setOnRepeat(getOnRepeat(16) as SongLike[])
    setTimeCapsule(getTimeCapsule(16) as SongLike[])
  }, [recentSongs.length])

  // --- Daylist: se recalcula cada vez que cambia la franja horaria activa ---
  useEffect(() => {
    let mounted = true
    const meta = getDaylistMeta()
    setDaylistTitle(meta.title)
    getDaylistSongs(20)
      .then((r) => { if (mounted) setDaylist(r) })
      .catch(() => {})
    return () => { mounted = false }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [Math.floor(Date.now() / (60 * 60 * 1000))])


  // --- Discovery & Similar Tracks (New Engine) ---
  useEffect(() => {
    const scores = getSongAffinityScores()
    const topSongEntries = [...scores.entries()].sort((a, b) => b[1] - a[1])
    const known = [...favoriteSongs, ...recentSongs]
    
    if (topSongEntries.length > 0 && topSongEntries[0]) {
      const bestId = topSongEntries[0][0]
      const bestSong = known.find(s => String(s.id) === bestId)
      if (bestSong) {
        setSimilarSeedTitle(bestSong.title || bestSong.artist || 'tus favoritas')
        // We use the artist search as a proxy for "similar to track" since YT music radio API is closed
        getTopArtistRecommendations(bestSong.artist, known, 16)
          .then((r) => setSimilarTracks(r))
          .catch(() => {})
      }
    }
    
    const genres = getTopGenre(2)
    if (genres.length > 0) {
      // Discovery: Fetch trending in top genres, but strictly filter out known tracks
      const discoveryPromises = genres.map(g => getGenreTrending(g, 20))
      Promise.all(discoveryPromises).then(results => {
        const allNew = results.flat().filter(s => !known.some(k => isSameSong(k, s)))
        // Shuffle discovery tracks
        for (let i = allNew.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [allNew[i], allNew[j]] = [allNew[j]!, allNew[i]!];
        }
        setDiscoveryTracks(allNew.slice(0, 16))
      }).catch(() => {})
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [favoriteSongs.length, recentSongs.length])

  // --- Handlers ---
  const handleSearchSubmit = (e: { preventDefault: () => void }) => {
    e.preventDefault()
    const q = query.trim()
    if (!q) return
    setSearchOpen(false)
    navigate(`/discover?q=${encodeURIComponent(q)}`)
  }

  const handlePlayFrom = useCallback((list: SongLike[], song: SongLike) => {
    const index = list.findIndex((s) => s.id === song.id)
    // Se navega YA, sin esperar a que playQueueAt resuelva el audio: el
    // set() síncrono al inicio de playQueueAt ya deja song/currentIndex
    // listos antes de este navigate (todavía no hubo ningún await), así
    // que el reproductor principal monta directo con ese estado — nunca
    // llega a haber un render intermedio en esta página con la mini
    // barra flotante puesta antes de saltar al reproductor. La carga del
    // audio en sí (buffering / fallback a YouTube) se ve dentro del
    // reproductor principal, que ya tiene su propio indicador.
    void playQueueAt(list, index === -1 ? 0 : index).catch(() => {})
    navigate('/player')
  }, [playQueueAt, navigate])

  // MEJORA de performance: un `onPlay` estable por sección (en vez de la
  // arrow function `(song) => handlePlayFrom(list, song)` de siempre,
  // recreada en CADA render de HomePage) es lo que le permite a
  // React.memo en SongCard/QuickGridCard funcionar de verdad — antes,
  // tipear en el buscador o cambiar de país en Top Global volvía a
  // renderizar TODAS las tarjetas de TODOS los carruseles del Home, aunque
  // ninguna canción visible hubiera cambiado. Cada wrapper solo cambia de
  // referencia cuando la lista de esa sección de verdad cambia.
  const playRecent = useCallback((song: SongLike) => handlePlayFrom(recentSongs, song), [handlePlayFrom, recentSongs])
  const playRecommended = useCallback((song: SongLike) => handlePlayFrom(recommended, song), [handlePlayFrom, recommended])
  const playSimilar = useCallback((song: SongLike) => handlePlayFrom(similarTracks, song), [handlePlayFrom, similarTracks])
  const playArtistRecs = useCallback((song: SongLike) => handlePlayFrom(artistRecs, song), [handlePlayFrom, artistRecs])
  const playDiscovery = useCallback((song: SongLike) => handlePlayFrom(discoveryTracks, song), [handlePlayFrom, discoveryTracks])
  const playDaylist = useCallback((song: SongLike) => handlePlayFrom(daylist, song), [handlePlayFrom, daylist])
  const playOnRepeat = useCallback((song: SongLike) => handlePlayFrom(onRepeat, song), [handlePlayFrom, onRepeat])
  const playTrending = useCallback((song: SongLike) => handlePlayFrom(trending, song), [handlePlayFrom, trending])
  const playGenre = useCallback((song: SongLike) => handlePlayFrom(genreTracks, song), [handlePlayFrom, genreTracks])
  const playAppleChart = useCallback((song: SongLike) => handlePlayFrom(appleCharts, song), [handlePlayFrom, appleCharts])
  const playFavorite = useCallback((song: SongLike) => handlePlayFrom(favoriteSongs, song), [handlePlayFrom, favoriteSongs])
  const playTimeCapsule = useCallback((song: SongLike) => handlePlayFrom(timeCapsule, song), [handlePlayFrom, timeCapsule])

  const handleSelectSong = (song: Song) => {
    setSearchOpen(false)
    // Mismo criterio que en Discover: al elegir un resultado de búsqueda
    // puntual pasamos a una radio del artista, no seguimos ofreciendo el
    // resto de "coincidencias de texto" de esta búsqueda rápida.
    void playSongRadio(song, searchResults.songs).catch(() => {})
    navigate('/player')
  }

  const handleSelectArtist = (artist: ArtistResult) => {
    setSearchOpen(false)
    navigate(`/artist/${encodeURIComponent(artist.name)}?id=${encodeURIComponent(artist.artistId)}`)
  }

  const hasResults = searchResults.songs.length > 0 || searchResults.artists.length > 0
  const showPanel = searchOpen && query.trim().length > 0

  return (
    <div className="home-page">
      <Sidebar />
      <div className="home-ambient-glow" aria-hidden="true" />

      {/* --- Header --- */}
      <motion.header
        className="home-header"
        initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -14 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ type: 'spring', stiffness: 300, damping: 30 }}
      >
        <div className="home-header-logo">
          <img src="/icons/xfy-mark.png" alt="XFY" />
        </div>

        {/* Centered search bar in the header */}
        <div className="home-header-search" ref={searchWrapRef}>
          <form className="home-search-field" onSubmit={handleSearchSubmit}>
            <Search size={15} />
            <input
              ref={searchInputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onFocus={() => setSearchOpen(true)}
              placeholder="Artistas, canciones…"
              aria-label="Buscar música"
              role="combobox"
              aria-expanded={showPanel}
              aria-controls="home-search-results-panel"
              autoComplete="off"
            />
            {searchLoading && <Loader2 size={14} className="home-search-spinner" />}
          </form>

          <AnimatePresence>
            {showPanel && (
              <motion.div
                id="home-search-results-panel"
                role="listbox"
                aria-label="Resultados de búsqueda"
                className="home-search-results"
                initial={{ opacity: 0, y: -8, scale: 0.97 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: -8, scale: 0.97 }}
                transition={{ type: 'spring', stiffness: 400, damping: 30 }}
              >
                {!hasResults ? (
                  searchLoading
                    ? <SearchLoadingIndicator reduceMotion={reduceMotion} />
                    : <p className="home-search-results-empty">Sin resultados para "{query.trim()}".</p>
                ) : (
                  <>
                    {searchResults.artists.length > 0 && (
                      <div className="home-search-results-group">
                        <p className="home-search-results-label">Artistas</p>
                        {searchResults.artists.map((artist) => (
                          <button
                            key={artist.artistId}
                            type="button"
                            className="home-search-result home-search-result--artist"
                            onClick={() => handleSelectArtist(artist)}
                          >
                            {artist.thumbUrl
                              ? <CachedImg src={artist.thumbUrl} alt="" className="home-search-result-art" />
                              : <div className="home-search-result-art home-search-result-art--fallback"><Mic2 size={14} /></div>
                            }
                            <div className="home-search-result-info">
                              <p className="home-search-result-title">{artist.name}</p>
                              <p className="home-search-result-sub">Artista</p>
                            </div>
                          </button>
                        ))}
                      </div>
                    )}
                    {searchResults.songs.length > 0 && (
                      <div className="home-search-results-group">
                        <p className="home-search-results-label">Canciones</p>
                        {searchResults.songs.map((song) => (
                          <button
                            key={song.id}
                            type="button"
                            className="home-search-result"
                            onClick={() => handleSelectSong(song)}
                          >
                            {song.albumArtUrl
                              ? <CachedImg song={song} alt="" className="home-search-result-art" />
                              : <div className="home-search-result-art home-search-result-art--fallback"><Search size={12} /></div>
                            }
                            <div className="home-search-result-info">
                              <p className="home-search-result-title">{song.title}</p>
                              <p className="home-search-result-sub">
                                {[song.artist, song.album].filter(Boolean).join(' · ')}
                              </p>
                            </div>
                          </button>
                        ))}
                      </div>
                    )}
                    <button type="button" className="home-search-results-all" onClick={handleSearchSubmit}>
                      Ver todos los resultados para "{query.trim()}"
                    </button>
                  </>
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        <Menu.Root>
          <Menu.Trigger className="home-header-avatar">
            <img src={currentUser?.avatarUrl || 'https://placehold.co/32x32/8b5cf6/ffffff?text=U'} alt="" />
            <span>{currentUser?.nickname}</span>
          </Menu.Trigger>
          <Menu.Portal>
            <Menu.Positioner sideOffset={8} align="end">
              <Menu.Popup className="home-header-menu">
                <Menu.Item className="home-header-menu-item" onClick={() => navigate('/wrapped')}>
                  <Sparkle size={15} />
                  Tu Wrapped
                </Menu.Item>
                <Menu.Item className="home-header-menu-item" onClick={() => navigate('/blend')}>
                  <Users2 size={15} />
                  Blend
                </Menu.Item>
                <Menu.Item className="home-header-menu-item" onClick={() => navigate('/discover')}>
                  <Compass size={15} />
                  Descubrir
                </Menu.Item>
                <Menu.Item className="home-header-menu-item" onClick={() => navigate('/settings')}>
                  <UserRound size={15} />
                  Editar perfil
                </Menu.Item>
                <Menu.Item className="home-header-menu-item" onClick={logout}>
                  <LogOut size={15} />
                  Cerrar sesión
                </Menu.Item>
              </Menu.Popup>
            </Menu.Positioner>
          </Menu.Portal>
        </Menu.Root>
      </motion.header>

      {/* --- Main content --- */}
      <main className="home-content">

        {/* Hero greeting */}
        <div className="home-hero-header">
          <HeroGreeting userName={currentUser?.nickname} />
          {userContext && userContext.genres.length > 0 && (
            <div className="home-taste-badges" style={{ display: 'flex', gap: '8px', padding: '0 24px', marginBottom: '24px', overflowX: 'auto', WebkitOverflowScrolling: 'touch' }}>
              <span style={{ fontSize: '12px', fontWeight: 600, color: 'var(--color-text-secondary)', display: 'flex', alignItems: 'center' }}>Tu perfil de gusto:</span>
              {userContext.genres.slice(0, 3).map((g, i) => (
                <div key={i} style={{ 
                  background: 'rgba(255,255,255,0.05)', 
                  border: '1px solid rgba(255,255,255,0.1)',
                  borderRadius: '16px', 
                  padding: '4px 12px', 
                  fontSize: '13px',
                  color: 'var(--color-text-primary)',
                  backdropFilter: 'blur(10px)'
                }}>
                  {g.name} <span style={{ opacity: 0.5, fontSize: '11px', marginLeft: '4px' }}>{Math.round(g.score / 100)}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Visto recientemente - 2x4 grid */}
        {recentSongs.length > 0 && (
          <QuickGrid songs={recentSongs} onPlay={playRecent} />
        )}

        {/* For you */}
        {recommended.length > 0 && (
          <QuickGrid
            songs={recommended}
            onPlay={playRecommended}
            title="Para ti"
            kicker="Basado en tus gustos y hábitos de escucha"
          />
        )}

        {/* Porque escuchaste mucho X (Completion-weighted) */}
        {similarTracks.length > 0 && (
          <QuickGrid
            songs={similarTracks}
            onPlay={playSimilar}
            title={`Porque escuchaste mucho "${similarSeedTitle}"`}
            kicker="Sugerencias basadas en tus tracks con mayor affinity"
          />
        )}
        
        {/* Because you liked X (Artist based fallback) */}
        {artistRecs.length > 0 && similarTracks.length === 0 && (
          <QuickGrid
            songs={artistRecs}
            onPlay={playArtistRecs}
            title={`Porque te gustó ${topArtist}`}
            kicker="Más de lo que ya amás"
          />
        )}
        
        {/* Descubrimiento de la semana (Unplayed tracks matching genre affinity) */}
        {discoveryTracks.length > 0 && (
          <QuickGrid
            songs={discoveryTracks}
            onPlay={playDiscovery}
            title="Descubrimiento"
            kicker="Canciones nuevas para ti que coinciden con tus géneros favoritos"
          />
        )}

        {/* Daylist */}
        {daylist.length > 0 && (
          <QuickGrid
            songs={daylist}
            onPlay={playDaylist}
            title={daylistTitle}
            kicker="Tu mix del momento — cambia con la hora del día"
          />
        )}

        {/* On Repeat */}
        {onRepeat.length > 0 && (
          <QuickGrid
            songs={onRepeat}
            onPlay={playOnRepeat}
            title="On Repeat"
            kicker="Lo que más escuchaste este mes"
          />
        )}

        {/* Trending YT Music */}
        <QuickGrid
          songs={trending}
          onPlay={playTrending}
          title="Tendencias en YT Music"
          kicker="Lo más escuchado ahora mismo"
          showBadge
          action="Ver todo"
          onAction={() => navigate('/discover')}
        />

        {/* Hot in [genre] */}
        {genreTracks.length > 0 && (
          <QuickGrid
            songs={genreTracks}
            onPlay={playGenre}
            title={`Hot en ${topGenre}`}
            kicker={`Tu género más escuchado, en tendencia`}
          />
        )}

        {/* Apple Music Top Global — con selector de país (appleCharts.ts ya
            soportaba 9 mercados vía APPLE_CHART_COUNTRIES, pero el Home
            tenía 'us' fijo y nunca se conectó a la UI). Header propio acá
            afuera (no vía las props title/kicker de QuickGrid) para poder
            meter las píldoras de país al lado del título sin duplicar ni
            reescribir la lógica de las tarjetas (Tilt3D, warm-on-hover,
            badge de ranking) que QuickGrid ya resuelve bien tal cual. */}
        <section className="qg-section top-global-section">
          <div className="qg-header tg-header">
            <div>
              <h2 className="home-section-title">Top Global</h2>
              <p className="qg-kicker">
                Apple Music Charts · {APPLE_CHART_COUNTRIES.find((c) => c.id === appleCountry)?.label}
              </p>
            </div>
            <div className="tg-country-row custom-scroll custom-scroll--autohide" ref={countryRowRef} role="radiogroup" aria-label="País del chart">
              {APPLE_CHART_COUNTRIES.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  role="radio"
                  aria-checked={appleCountry === c.id}
                  className={`tg-pill${appleCountry === c.id ? ' active' : ''}`}
                  onClick={() => handleAppleCountryChange(c.id)}
                >
                  {c.label}
                </button>
              ))}
            </div>
          </div>

          {appleLoading && appleCharts.length === 0 ? (
            <div className="qg-row" aria-hidden="true">
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="skeleton-card" />
              ))}
            </div>
          ) : (
            <QuickGrid
              songs={appleCharts}
              onPlay={playAppleChart}
              showBadge
            />
          )}
        </section>

        {/* Favorites */}
        {favoriteSongs.length > 0 && (
          <QuickGrid
            title="Tus favoritas"
            songs={favoriteSongs}
            onPlay={playFavorite}
          />
        )}

        {/* Time Capsule */}
        {timeCapsule.length > 0 && (
          <QuickGrid
            title="Cápsula del tiempo"
            kicker="Las amaste hace un tiempo — hace rato no las escuchás"
            songs={timeCapsule}
            onPlay={playTimeCapsule}
          />
        )}

        {/* Empty state - New user */}
        {recentSongs.length === 0 && favoriteSongs.length === 0 && trending.length === 0 && (
          <motion.section
            className="home-section home-empty-state"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.4 }}
          >
            <TrendingUp size={32} className="home-empty-icon" />
            <p className="home-empty-title">Bienvenido a XFY</p>
            <p className="home-empty-sub">Buscá canciones para empezar a personalizar tu experiencia.</p>
            <button className="home-empty-cta" onClick={() => navigate('/discover')}>
              <Compass size={16} />
              Explorar música
            </button>
          </motion.section>
        )}
      </main>
    </div>
  )
}
