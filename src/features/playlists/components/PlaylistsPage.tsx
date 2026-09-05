import { useState, useEffect, useRef } from 'react'
import type { FC, FormEvent, MouseEvent } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { ListMusic, Plus, Download, Search, X, Loader2, Music2, ArrowLeft, Play } from 'lucide-react'
import { motion, AnimatePresence, useReducedMotion } from 'motion/react'
import { toast } from 'sonner'
import { useAuthStore, isSongFavorite } from '@features/auth'
import { usePlaylistsStore } from '@features/playlists/store/usePlaylistsStore'
import { searchYTPlaylists, getYTPlaylist, type YTPlaylistDetail } from '@services/api/ytPlaylist'
import ImportSpotifyModal, { type SpotifyImportResult } from '@features/playlists/components/ImportSpotifyModal'
import type { PlaylistInfo, Song } from '@/types/models'
import Sidebar from '@shared/components/Sidebar'
import CachedImgUntyped from '@shared/components/CachedImg'
import useCanHover from '@shared/lib/useCanHover'
import { warmYouTubeAudio } from '@features/player/lib/ytblob'
import type { PlaylistSong } from '@shared/lib/db'
import './PlaylistsPage.css'

// Dispara el precaché server-side del audio apenas una canción entra a
// una playlist recién importada — mismo mecanismo idempotente/rate-
// limited que ya usan las tarjetas al hover (ver PlaylistDetailPage),
// solo que acá arranca de una en vez de esperar a que el usuario toque
// play. Va DENTRO del mismo chunk de `addSong` (máx. 6 en paralelo), no
// suelto en un loop propio — así no dispara cientos de POST a
// /api/ytcache de golpe en una playlist grande, que es lo que generaba
// choques/errores al reproducir un tema recién importado.
function warmImportedSong(song: (Song & { source?: string | null }) | null | undefined) {
  if (song?.source === 'youtube' && (song.videoId || song.id)) {
    warmYouTubeAudio(String(song.videoId || song.id), { title: song.title, artist: song.artist })
  }
}

// borde JS->TS: CachedImg todavía no tipa sus props (la inferencia del .tsx
// marca song/className como requeridos aunque en runtime son opcionales).
// Alias con el contrato real con el que esta página lo usa.
const CachedImg = CachedImgUntyped as FC<{
  src?: string | null
  song?: PlaylistSong
  alt?: string
  className?: string
  title?: string | null
}>

// --- Playlist Cover Collage (up to 4 album arts, o foto personalizada) ---
function PlaylistCover({
  songs,
  coverUrl,
  size = 56,
}: {
  songs: PlaylistSong[]
  coverUrl?: string | null
  size?: number
}) {
  if (coverUrl)
    return (
      <div className="pl-cover" style={{ width: size, height: size }}>
        <CachedImg src={coverUrl} alt="" title="playlist" />
      </div>
    )

  const arts = [...new Map(songs.map((s) => [s.albumArtUrl, s])).values()]
    .filter((s) => s.albumArtUrl)
    .slice(0, 4)
    .map((s) => s.albumArtUrl)

  if (arts.length === 0)
    return (
      <div className="pl-cover pl-cover--empty" style={{ width: size, height: size }}>
        <ListMusic size={size * 0.38} />
      </div>
    )

  if (arts.length < 4)
    return (
      <div className="pl-cover" style={{ width: size, height: size }}>
        <CachedImg src={arts[0]} alt="" title="playlist" />
      </div>
    )

  return (
    <div className="pl-cover pl-cover--quad" style={{ width: size, height: size }}>
      {arts.map((url, i) => (
        <CachedImg key={i} src={url} alt="" title="playlist" />
      ))}
    </div>
  )
}

// --- Preview de una playlist de YT antes de importarla ---
function PlaylistPreview({
  pl,
  onBack,
  onImport,
}: {
  pl: PlaylistInfo
  onBack: () => void
  onImport: (data: YTPlaylistDetail | null, addAllToFavorites: boolean) => Promise<void> | void
}) {
  const [data, setData] = useState<YTPlaylistDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [importing, setImporting] = useState(false)
  const [addAllToFavorites, setAddAllToFavorites] = useState(false)

  const prevPlRef = useRef(pl?.id)
  useEffect(() => {
    const plId = pl?.id
    if (prevPlRef.current !== plId) {
      setLoading(true)
      prevPlRef.current = plId
    }
    let live = true
    getYTPlaylist(plId || pl.playlistId)
      .then((d) => { if (live) { setData(d); setLoading(false) } })
      .catch(() => { if (live) setLoading(false) })
    return () => { live = false }
  }, [pl?.id, pl?.playlistId])

  const songs = data?.songs || []

  const handleImportClick = async () => {
    if (!songs.length) return
    setImporting(true)
    try {
      await onImport(data, addAllToFavorites)
    } finally {
      setImporting(false)
    }
  }

  return (
    <>
      <div className="import-modal-header import-preview-header">
        <button className="import-preview-back" onClick={onBack} aria-label="Volver a resultados">
          <ArrowLeft size={17} />
        </button>
        <div className="import-preview-art">
          {pl.thumbUrl
            ? <CachedImg src={pl.thumbUrl} alt="" title={pl.title} />
            : <Music2 size={20} />
          }
        </div>
        <div className="import-preview-headtext">
          <p className="import-modal-title" title={pl.title}>{pl.title}</p>
          <p className="import-result-sub">
            {pl.author || 'YouTube Music'}
            {!loading && songs.length ? ` · ${songs.length} canciones` : ''}
          </p>
        </div>
        <button className="import-modal-close" onClick={onBack}><X size={18} /></button>
      </div>

      <div className="import-preview-body">
        {loading && (
          <div className="import-preview-loading">
            <Loader2 size={20} className="import-spinner" />
            <p className="import-hint">Cargando canciones…</p>
          </div>
        )}

        {!loading && songs.length === 0 && (
          <p className="import-hint">No se pudieron cargar las canciones de esta playlist.</p>
        )}

        {!loading && songs.length > 0 && (
          <div className="import-preview-songs">
            {songs.map((song, idx) => {
              const dur = song.duration
              const durStr = dur
                ? `${Math.floor(dur / 60)}:${String(Math.floor(dur % 60)).padStart(2, '0')}`
                : null
              return (
                <div key={song.id || idx} className="import-preview-song">
                  <span className="import-preview-song-num">{idx + 1}</span>
                  <div className="import-preview-song-art">
                    <CachedImg song={song} alt="" title={song.title} />
                  </div>
                  <div className="import-preview-song-info">
                    <p className="import-preview-song-title">{song.title}</p>
                    <p className="import-preview-song-artist">{song.artist}</p>
                  </div>
                  {durStr && <span className="import-preview-song-dur">{durStr}</span>}
                </div>
              )
            })}
          </div>
        )}
      </div>

      <div className="import-preview-footer">
        <label className="import-hint" style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10, cursor: songs.length ? 'pointer' : 'default' }}>
          <input
            type="checkbox"
            checked={addAllToFavorites}
            disabled={loading || songs.length === 0}
            onChange={(e) => setAddAllToFavorites(e.target.checked)}
          />
          También agregar estos temas a Favoritos
        </label>
        <button
          className="pl-action-btn pl-action-btn--primary import-preview-import-btn"
          onClick={handleImportClick}
          disabled={loading || importing || songs.length === 0}
        >
          {importing
            ? <Loader2 size={14} className="import-spinner" />
            : <Download size={14} />
          }
          {importing ? 'Importando…' : `Importar${songs.length ? ` (${songs.length})` : ''}`}
        </button>
      </div>
    </>
  )
}

// --- Import YT Playlist Modal ---
function ImportModal({
  onClose,
  onImport,
}: {
  onClose: () => void
  onImport: (data: YTPlaylistDetail | null, addAllToFavorites: boolean) => Promise<void> | void
}) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<PlaylistInfo[]>([])
  const [loading, setLoading] = useState(false)
  const [importing, setImporting] = useState<string | null>(null)
  const [preview, setPreview] = useState<PlaylistInfo | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const reduceMotion = useReducedMotion()

  useEffect(() => { if (!preview) inputRef.current?.focus() }, [preview])

  const prevQueryRef = useRef(query)
  useEffect(() => {
    const t = query.trim()
    if (!t) {
      if (prevQueryRef.current !== query) {
        setResults([])
        prevQueryRef.current = query
      }
      return
    }
    if (prevQueryRef.current !== query) {
      setLoading(true)
      prevQueryRef.current = query
    }
    let live = true
    const timer = setTimeout(() =>
      searchYTPlaylists(t, 10)
        .then((r) => { if (live) { setResults(r); setLoading(false) } })
        .catch(() => { if (live) setLoading(false) }),
      350,
    )
    return () => { live = false; clearTimeout(timer) }
  }, [query])

  const handleQuickImport = async (e: MouseEvent, pl: PlaylistInfo) => {
    e.stopPropagation()
    setImporting(pl.id)
    try {
      const data = await getYTPlaylist(pl.playlistId || pl.id)
      if (!data?.songs?.length) {
        toast.error('No se pudieron cargar las canciones de esta playlist.')
      } else {
        onImport(data, false)
        onClose()
      }
    } catch {
      toast.error('No se pudo importar la playlist. Intenta de nuevo.')
    } finally {
      setImporting(null)
    }
  }

  const handleImportFromPreview = async (data: YTPlaylistDetail | null, addAllToFavorites: boolean) => {
    if (!data?.songs?.length) {
      toast.error('No se pudieron cargar las canciones de esta playlist.')
      return
    }
    try {
      await onImport(data, addAllToFavorites)
    } catch {
      toast.error('No se pudo importar la playlist. Intenta de nuevo.')
    }
    onClose()
  }

  return (
    <motion.div
      className="import-backdrop"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <motion.div
        className={`import-modal ${preview ? 'import-modal--preview' : ''}`}
        initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 32, scale: 0.96 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 20, scale: 0.97 }}
        transition={{ type: 'spring', stiffness: 380, damping: 30 }}
      >
        {preview ? (
          <PlaylistPreview
            pl={preview}
            onBack={() => setPreview(null)}
            onImport={handleImportFromPreview}
          />
        ) : (
          <>
            <div className="import-modal-header">
              <div>
                <p className="import-modal-kicker">YouTube Music</p>
                <h2 className="import-modal-title">Importar playlist</h2>
              </div>
              <button className="import-modal-close" onClick={onClose}><X size={18} /></button>
            </div>

            <div className="import-search-field">
              <Search size={15} />
              <input
                ref={inputRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Buscar playlists en YT Music…"
              />
              {loading && <Loader2 size={14} className="import-spinner" />}
            </div>

            <div className="import-results">
              {!query.trim() && (
                <p className="import-hint">
                  Buscá por nombre de playlist, artista o álbum de YouTube Music.
                </p>
              )}
              {query.trim() && !loading && results.length === 0 && (
                <p className="import-hint">Sin resultados. Probá con otro término.</p>
              )}
              {results.map((pl) => (
                <motion.div
                  key={pl.id}
                  className="import-result"
                  onClick={() => setPreview(pl)}
                  role="button"
                  tabIndex={0}
                  initial={reduceMotion ? { opacity: 0 } : { opacity: 0, x: -8 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ type: 'spring', stiffness: 400, damping: 32 }}
                >
                  <div className="import-result-art">
                    {pl.thumbUrl
                      ? <CachedImg src={pl.thumbUrl} alt="" title={pl.title} />
                      : <Music2 size={18} />
                    }
                    <div className="import-result-play"><Play size={14} fill="currentColor" /></div>
                  </div>
                  <div className="import-result-info">
                    <p className="import-result-title">{pl.title}</p>
                    <p className="import-result-sub">
                      {pl.author || 'YouTube Music'}{pl.count ? ` · ${pl.count} canciones` : ''}
                    </p>
                  </div>
                  <button
                    className="import-result-btn"
                    onClick={(e) => handleQuickImport(e, pl)}
                    disabled={!!importing}
                  >
                    {importing === pl.id
                      ? <Loader2 size={14} className="import-spinner" />
                      : <Download size={14} />
                    }
                    {importing === pl.id ? 'Importando…' : 'Importar'}
                  </button>
                </motion.div>
              ))}
            </div>
          </>
        )}
      </motion.div>
    </motion.div>
  )
}

// --- Main Page ---
export default function PlaylistsPage() {
  const navigate = useNavigate()
  const location = useLocation()
  const currentUser = useAuthStore((s) => s.currentUser)
  const playlists = usePlaylistsStore((s) => s.playlists)
  const createPlaylist = usePlaylistsStore((s) => s.createPlaylist)
  const addSongs = usePlaylistsStore((s) => s.addSongs)
  const addFavorites = useAuthStore((s) => s.addFavorites)

  const [showCreate, setShowCreate] = useState(false)
  const [newName, setNewName] = useState('')
  const [showImport, setShowImport] = useState(false)
  const [showImportSpotify, setShowImportSpotify] = useState(false)
  const nameInputRef = useRef<HTMLInputElement | null>(null)
  const canHover = useCanHover()
  const reduceMotion = useReducedMotion()

  useEffect(() => {
    if (!showCreate) return
    const timer = setTimeout(() => nameInputRef.current?.focus(), 50)
    return () => clearTimeout(timer)
  }, [showCreate])

  useEffect(() => {
    const params = new URLSearchParams(location.search)
    if (params.has('spotifyConnected')) {
      toast.success('Cuenta de Spotify conectada')
      setShowImportSpotify(true)
    } else if (params.has('spotifyError')) {
      toast.error('No se pudo conectar con Spotify')
    } else {
      return
    }
    navigate('/playlists', { replace: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.search])

  const handleCreate = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    if (!newName.trim() || !currentUser) return
    const pl = await createPlaylist(currentUser.email, newName.trim())
    setNewName('')
    setShowCreate(false)
    if (pl) {
      toast.success(`"${pl.name}" creada`)
      navigate(`/playlist/${pl.id}`)
    } else {
      toast.error('No se pudo crear la playlist.')
    }
  }

  const handleImport = async (ytData: YTPlaylistDetail | null, addAllToFavorites = false) => {
    if (!currentUser || !ytData) return
    const pl = await createPlaylist(currentUser.email, ytData.title ?? '')
    if (!pl) { toast.error('No se pudo crear la playlist.'); return }

    const total = ytData.songs.length
    const id = toast.loading(`Importando "${ytData.title}"…`)

    // Un solo request para las N canciones (endpoint addSongs, ya resuelto
    // en el backend en 2 round-trips como mucho) en vez de un POST por
    // canción — antes esto era exactamente lo que el batch existía para
    // evitar, pero el frontend nunca lo llamaba.
    const done = await addSongs(pl.id, ytData.songs)

    let favorited = 0
    if (done > 0) {
      // Precalentar solo las primeras 10 para no ahogar /api/ytcache y
      // evitar disparar el rate-limit de extracciones (429) masivamente —
      // ya no hace falta escalonarlo en chunks de 6: son fire-and-forget
      // (warmYouTubeAudio no espera respuesta) y 10 a la vez sigue siendo
      // muy por debajo del "cientos de golpe" que el tope original evitaba.
      ytData.songs.slice(0, 10).forEach(warmImportedSong)

      if (addAllToFavorites) {
        const toFavorite = ytData.songs.filter((s) => !isSongFavorite(currentUser, s))
        favorited = await addFavorites(toFavorite)
      }
    }

    if (done === 0) {
      toast.error(`No se pudo importar ninguna canción de "${ytData.title}".`, { id })
      return
    }
    const favSuffix = favorited > 0 ? ` · ${favorited} a Favoritos` : ''
    if (done < total) {
      toast.warning(`"${pl.name}" importada parcialmente — ${done}/${total} canciones${favSuffix}`, { id })
    } else {
      toast.success(`"${pl.name}" importada — ${total} canciones${favSuffix}`, { id })
    }
    navigate(`/playlist/${pl.id}`)
  }

  // Núcleo compartido: crea una playlist y le vuelca las selecciones ya
  // matcheadas. `toastId` opcional para que el import en bloque reuse un
  // único toast entre varias playlists en vez de abrir uno por cada una;
  // cuando no se pasa, esta función es dueña del toast y lo cierra ella
  // misma con el resultado final (si se pasa, el caller lo cierra).
  const importSpotifySelections = async (
    { title, selections }: SpotifyImportResult,
    toastId?: string | number,
  ): Promise<{ playlistId: string; done: number; total: number; favorited: number } | null> => {
    if (!currentUser || selections.length === 0) return null
    const pl = await createPlaylist(currentUser.email, title || 'Playlist de Spotify')
    if (!pl) return null

    const total = selections.length
    const id = toastId ?? toast.loading(`Importando "${pl.name}"…`)

    const songs = selections.map((sel) => sel.song)
    const done = await addSongs(pl.id, songs)

    let favorited = 0
    if (done > 0) {
      // Ver comentario equivalente en handleImport: 10 fire-and-forget de
      // una en vez de escalonados en chunks de 6, ya no hace falta
      // acoplarlo al loop de addSong porque ya no hay loop.
      songs.slice(0, 10).forEach(warmImportedSong)

      const toFavorite = selections
        .filter((sel) => sel.addToFavorites && !isSongFavorite(currentUser, sel.song))
        .map((sel) => sel.song)
      if (toFavorite.length > 0) favorited = await addFavorites(toFavorite)
    }

    if (toastId === undefined) {
      const favSuffix = favorited > 0 ? ` · ${favorited} a Favoritos` : ''
      if (done === 0) {
        toast.error(`No se pudo importar ninguna canción de "${title}".`, { id })
      } else if (done < total) {
        toast.warning(`"${title}" importada parcialmente — ${done}/${total} canciones${favSuffix}`, { id })
      } else {
        toast.success(`"${title}" importada — ${total} canciones${favSuffix}`, { id })
      }
    }
    return { playlistId: pl.id, done, total, favorited }
  }

  const handleImportSpotify = async (result: SpotifyImportResult) => {
    const outcome = await importSpotifySelections(result)
    if (!outcome) { toast.error('No se pudo crear la playlist.'); return }
    if (outcome.done > 0) navigate(`/playlist/${outcome.playlistId}`)
  }

  // Import en bloque desde la biblioteca conectada: varias playlists (y
  // opcionalmente Me Gusta) de una, con un único toast de progreso.
  const handleImportSpotifyBulk = async (items: SpotifyImportResult[]) => {
    if (items.length === 0) {
      toast.error('No se pudo importar ninguna canción.')
      return
    }
    const id = toast.loading(`Importando ${items.length} de Spotify… 0/${items.length}`)
    let lastPlaylistId: string | null = null
    let okCount = 0
    let totalSongs = 0
    let totalFavorited = 0

    for (let i = 0; i < items.length; i += 1) {
      const item = items[i]!
      toast.loading(`Importando "${item.title}"… (${i + 1}/${items.length})`, { id })
      const outcome = await importSpotifySelections(item, id)
      if (outcome && outcome.done > 0) {
        okCount += 1
        totalSongs += outcome.done
        totalFavorited += outcome.favorited
        lastPlaylistId = outcome.playlistId
      }
    }

    if (okCount === 0) {
      toast.error('No se pudo importar ninguna playlist.', { id })
      return
    }
    const favSuffix = totalFavorited > 0 ? ` · ${totalFavorited} a Favoritos` : ''
    toast.success(`Importaste ${okCount} de ${items.length} · ${totalSongs} canciones${favSuffix}`, { id })
    if (okCount === 1 && lastPlaylistId) navigate(`/playlist/${lastPlaylistId}`)
  }

  return (
    <div className="playlists-page">
      <Sidebar />

      <header className="pl-page-header">
        <div>
          <p className="home-section-kicker">Tu biblioteca</p>
          <h1 className="pl-page-title">Playlists</h1>
        </div>
        <div className="pl-page-actions">
          <motion.button
            className="pl-action-btn pl-action-btn--secondary"
            onClick={() => setShowImport(true)}
            whileHover={canHover ? { scale: 1.03 } : undefined} whileTap={{ scale: 0.97 }}
          >
            <Download size={15} />
            Importar de YT
          </motion.button>
          <motion.button
            className="pl-action-btn pl-action-btn--secondary"
            onClick={() => setShowImportSpotify(true)}
            whileHover={canHover ? { scale: 1.03 } : undefined} whileTap={{ scale: 0.97 }}
          >
            <Download size={15} />
            Importar de Spotify
          </motion.button>
          <motion.button
            className="pl-action-btn pl-action-btn--primary"
            onClick={() => setShowCreate((v) => !v)}
            whileHover={canHover ? { scale: 1.03 } : undefined} whileTap={{ scale: 0.97 }}
          >
            <Plus size={15} />
            Nueva
          </motion.button>
        </div>
      </header>

      {/* Inline Create Form */}
      <AnimatePresence>
        {showCreate && (
          <motion.form
            className="pl-create-form"
            onSubmit={handleCreate}
            initial={reduceMotion ? { opacity: 0 } : { opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={reduceMotion ? { opacity: 0 } : { opacity: 0, height: 0 }}
            transition={{ type: 'spring', stiffness: 400, damping: 32 }}
          >
            <input
              ref={nameInputRef}
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="Nombre de la playlist…"
              aria-label="Nombre de la playlist"
            />
            <button type="submit" disabled={!newName.trim()} className="pl-action-btn pl-action-btn--primary">
              Crear
            </button>
            <button type="button" className="pl-create-cancel" onClick={() => { setShowCreate(false); setNewName('') }}>
              <X size={16} />
            </button>
          </motion.form>
        )}
      </AnimatePresence>

      {/* Playlists Grid */}
      {playlists.length === 0 ? (
        <motion.div
          className="pl-empty"
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.2 }}
        >
          <ListMusic size={40} className="pl-empty-icon" />
          <p className="pl-empty-title">Sin playlists todavía</p>
          <p className="pl-empty-sub">Creá una nueva o importá una de YouTube Music.</p>
        </motion.div>
      ) : (
        <div className="pl-grid">
          {playlists.map((pl, i) => {
            const songs = pl.songs || []
            return (
              <motion.button
                key={pl.id}
                className="pl-card"
                onClick={() => navigate(`/playlist/${pl.id}`)}
                initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 16 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ type: 'spring', stiffness: 320, damping: 28, delay: Math.min(i * 0.05, 0.35) }}
                whileHover={canHover ? { y: -3 } : undefined}
                whileTap={{ scale: 0.97 }}
              >
                <div className="pl-card-cover">
                  <PlaylistCover songs={songs} coverUrl={pl.coverUrl} size={160} />
                </div>
                <div className="pl-card-info">
                  <p className="pl-card-name" title={pl.name}>{pl.name}</p>
                  <p className="pl-card-meta">{songs.length} {songs.length === 1 ? 'canción' : 'canciones'}</p>
                </div>
              </motion.button>
            )
          })}
        </div>
      )}

      {/* Import Modal */}
      <AnimatePresence>
        {showImport && (
          <ImportModal onClose={() => setShowImport(false)} onImport={handleImport} />
        )}
        {showImportSpotify && (
          <ImportSpotifyModal
            onClose={() => setShowImportSpotify(false)}
            onImport={handleImportSpotify}
            onImportBulk={handleImportSpotifyBulk}
          />
        )}
      </AnimatePresence>
    </div>
  )
}
