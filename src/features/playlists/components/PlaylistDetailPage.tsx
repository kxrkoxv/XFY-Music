import { useEffect, useRef, useState } from 'react'
import type { ChangeEvent, FC, MouseEvent } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { Play, Shuffle, Trash2, X, Music2, Clock, Camera, Loader2 } from 'lucide-react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { toast } from 'sonner'
import { usePlayerStore } from '@features/player'
import { usePlaylistsStore } from '@features/playlists/store/usePlaylistsStore'
import { fileToResizedDataUrl } from '@features/playlists/lib/assets'
import Sidebar from '@shared/components/Sidebar'
import BackButton from '@shared/components/BackButton'
import CachedImgUntyped from '@shared/components/CachedImg'
import ArtistLinksUntyped from '@shared/components/ArtistLinks'
import useCanHover from '@shared/lib/useCanHover'
import { warmYouTubeAudio } from '@features/player/lib/ytblob'
import type { PlaylistSong } from '@shared/lib/db'
import type { SongLike } from '@shared/lib/songIdentity'
import './PlaylistsPage.css'

// borde JS->TS: CachedImg/ArtistLinks todavía no tipan sus props (la
// inferencia marca song/title/className como requeridos aunque en runtime
// son opcionales). Alias con el contrato real de esta página.
const CachedImg = CachedImgUntyped as FC<{
  src?: string | null
  song?: PlaylistSong
  alt?: string
  className?: string
  title?: string | null
}>
const ArtistLinks = ArtistLinksUntyped as FC<{
  song?: SongLike | null
  className?: string
  title?: string | null
}>

// Adelanta la resolución del stream de YouTube antes de que el usuario
// termine de tocar/soltar el click (ver SongCard.jsx para el detalle).
function warmIfYouTube(song: (SongLike & { source?: string | null }) | null | undefined) {
  if (song?.source === 'youtube' && (song.videoId || song.id)) {
    // borde JS->TS: los ids viejos pueden ser numéricos; warmYouTubeAudio espera string.
    warmYouTubeAudio((song.videoId || song.id) as string)
  }
}

function formatDuration(songs: (PlaylistSong & { durationSec?: number })[]) {
  const total = songs.reduce((acc, s) => acc + (s.duration || s.durationSec || 0), 0)
  if (!total) return null
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  if (h > 0) return `${h} h ${m} min`
  return `${m} min`
}

// Playlist hero cover: foto personalizada si existe, si no el collage
// automático de hasta 4 portadas de canciones.
function HeroCover({
  songs,
  coverUrl,
}: {
  songs: PlaylistSong[]
  coverUrl?: string | null
}) {
  if (coverUrl)
    return (
      <div className="pl-hero-cover">
        <CachedImg src={coverUrl} alt="" title="playlist" />
      </div>
    )

  const arts = [...new Map(songs.map((s) => [s.albumArtUrl, s])).values()]
    .filter((s) => s.albumArtUrl)
    .slice(0, 4)
    .map((s) => s.albumArtUrl)

  if (arts.length === 0)
    return (
      <div className="pl-hero-cover pl-hero-cover--empty">
        <Music2 size={52} />
      </div>
    )

  if (arts.length < 4)
    return (
      <div className="pl-hero-cover">
        <CachedImg src={arts[0]} alt="" title="playlist" />
      </div>
    )

  return (
    <div className="pl-hero-cover pl-hero-cover--quad">
      {arts.map((url, i) => (
        <CachedImg key={i} src={url} alt="" title="playlist" />
      ))}
    </div>
  )
}

export default function PlaylistDetailPage() {
  const navigate = useNavigate()
  const { playlistId } = useParams()
  const playlist = usePlaylistsStore((s) => s.getPlaylist(playlistId as string))
  const removeSong = usePlaylistsStore((s) => s.removeSong)
  const addSong = usePlaylistsStore((s) => s.addSong)
  const renamePlaylist = usePlaylistsStore((s) => s.renamePlaylist)
  const setPlaylistCover = usePlaylistsStore((s) => s.setPlaylistCover)
  const deletePlaylist = usePlaylistsStore((s) => s.deletePlaylist)
  // MEJORA de performance: mismo fix que en el resto de páginas — el resto
  // de los selectores de esta misma pantalla (arriba) ya lo hacía bien;
  // esta era la única que colaba el store completo.
  const playQueueAt = usePlayerStore((s) => s.playQueueAt)
  const [nameDraft, setNameDraft] = useState(() => playlist?.name || '')
  const [uploadingCover, setUploadingCover] = useState(false)
  const coverInputRef = useRef<HTMLInputElement | null>(null)
  const canHover = useCanHover()
  const reduceMotion = useReducedMotion()

  const prevPlaylistNameRef = useRef(playlist?.name)
  useEffect(() => {
    if (prevPlaylistNameRef.current !== playlist?.name) {
      setNameDraft(playlist?.name || '')
      prevPlaylistNameRef.current = playlist?.name
    }
  }, [playlist?.name])

  const handleCoverPick = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file || !playlist) return
    setUploadingCover(true)
    try {
      const dataUrl = await fileToResizedDataUrl(file)
      const ok = await setPlaylistCover(playlist.id, dataUrl)
      if (ok) toast.success('Portada actualizada')
      else toast.error('No se pudo guardar la foto.')
    } catch (err) {
      // borde JS->TS: en JS `err` era any; conservamos la misma lectura.
      toast.error((err as Error).message || 'No se pudo procesar la imagen.')
    } finally {
      setUploadingCover(false)
    }
  }

  const handleRemoveCover = async (e: MouseEvent) => {
    e.stopPropagation()
    if (!playlist) return
    const ok = await setPlaylistCover(playlist.id, null)
    if (ok) toast.success('Portada personalizada eliminada')
    else toast.error('No se pudo quitar la portada.')
  }

  const songs = playlist?.songs || []
  const duration = formatDuration(songs)

  if (!playlist) {
    return (
      <div className="playlists-page">
        <Sidebar />
        <p className="pl-empty-sub" style={{ marginTop: '4rem' }}>Esta playlist no existe o fue eliminada.</p>
      </div>
    )
  }

  const handlePlayAll = () => {
    if (!songs.length) return
    // Navegamos ya, sin esperar playQueueAt (ver comentario equivalente en
    // HomePage): su set() síncrono deja el estado listo antes de este
    // navigate, así que nunca se pinta la mini barra en esta página.
    void playQueueAt(songs, 0).catch(() => {})
    navigate('/player')
  }

  const handleShuffle = () => {
    if (!songs.length) return
    const shuffled = songs.toSorted(() => Math.random() - 0.5)
    void playQueueAt(shuffled, 0).catch(() => {})
    navigate('/player')
  }

  const handleDelete = async () => {
    const ok = await deletePlaylist(playlist.id)
    if (ok) { toast.success('Playlist eliminada'); navigate('/playlists') }
    else toast.error('No se pudo eliminar la playlist.')
  }

  return (
    <div className="playlists-page">
      <Sidebar />

      <BackButton to="/playlists" label="Playlists" />

      {/* Hero Section */}
      <motion.header
        className="pl-detail-hero"
        initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ type: 'spring', stiffness: 280, damping: 28 }}
      >
        <div
          className="pl-detail-cover-wrap"
          role="button"
          tabIndex={0}
          aria-label="Cambiar foto de la playlist"
          onClick={() => coverInputRef.current?.click()}
          onKeyDown={(e) => e.key === 'Enter' && coverInputRef.current?.click()}
        >
          <HeroCover songs={songs} coverUrl={playlist.coverUrl} />
          <div className="pl-cover-edit-overlay">
            {uploadingCover ? <Loader2 size={22} className="import-spinner" /> : <Camera size={22} />}
            <span>Cambiar foto</span>
          </div>
          {playlist.coverUrl && (
            <button
              type="button"
              className="pl-cover-remove"
              aria-label="Quitar foto personalizada"
              onClick={handleRemoveCover}
            >
              <X size={13} />
            </button>
          )}
          <input
            ref={coverInputRef}
            type="file"
            accept="image/*"
            hidden
            onChange={handleCoverPick}
          />
        </div>

        <div className="pl-detail-meta">
          <p className="home-section-kicker">Playlist</p>
          <input
            className="pl-detail-name"
            value={nameDraft}
            onChange={(e) => setNameDraft(e.target.value)}
            onBlur={() => nameDraft.trim() && nameDraft !== playlist.name && renamePlaylist(playlist.id, nameDraft)}
            aria-label="Nombre de la playlist"
          />
          <p className="pl-detail-counts">
            {songs.length} {songs.length === 1 ? 'canción' : 'canciones'}
            {duration && <><span className="pl-dot">·</span><Clock size={12} />{duration}</>}
          </p>

          <div className="pl-detail-actions">
            <motion.button
              className="pl-btn-play"
              onClick={handlePlayAll}
              disabled={!songs.length}
              whileHover={canHover ? { scale: 1.04 } : undefined} whileTap={{ scale: 0.96 }}
            >
              <Play size={17} fill="currentColor" />
              Reproducir
            </motion.button>
            <motion.button
              className="pl-btn-shuffle"
              onClick={handleShuffle}
              disabled={!songs.length}
              whileHover={canHover ? { scale: 1.04 } : undefined} whileTap={{ scale: 0.96 }}
            >
              <Shuffle size={16} />
              Aleatorio
            </motion.button>
            <motion.button
              className="pl-btn-delete"
              onClick={handleDelete}
              whileHover={canHover ? { scale: 1.04 } : undefined} whileTap={{ scale: 0.96 }}
            >
              <Trash2 size={15} />
            </motion.button>
          </div>
        </div>
      </motion.header>

      {/* Song List Section */}
      {songs.length === 0 ? (
        <div className="pl-empty" style={{ marginTop: '2rem' }}>
          <Music2 size={32} className="pl-empty-icon" />
          <p className="pl-empty-sub">Añadí canciones desde Inicio o Descubre.</p>
        </div>
      ) : (
        <div className="pl-song-list">
          {/* List Column Header */}
          <div className="pl-song-list-header">
            <span className="pl-song-col-num">#</span>
            <span>Título</span>
            <span className="pl-song-col-dur">Duración</span>
          </div>

          <AnimatePresence initial={false} mode="popLayout">
            {songs.map((song, idx) => {
            // borde JS->TS: los datos viejos guardaban la duración en `durationSec`.
            const legacyDur = (song as PlaylistSong & { durationSec?: number }).durationSec
            const dur = song.duration || legacyDur
            const durStr = dur
              ? `${Math.floor(dur / 60)}:${String(Math.floor(dur % 60)).padStart(2, '0')}`
              : null

  const handleRemoveSong = async (song: PlaylistSong) => {
    const ok = await removeSong(playlist.id, song.id)
    if (ok) {
      toast('Canción eliminada', {
        action: { label: 'Deshacer', onClick: () => addSong(playlist.id, song) },
      })
    } else {
      toast.error('No se pudo quitar la canción.')
    }
  }

  return (
              <motion.div
                key={song.id}
                layout
                className="pl-song-row"
                onClick={() => { void playQueueAt(songs, idx).catch(() => {}); navigate('/player') }}
                onPointerDown={() => warmIfYouTube(song)}
                onPointerEnter={() => warmIfYouTube(song)}
                initial={reduceMotion ? { opacity: 0 } : { opacity: 0, x: -8 }}
                animate={{ opacity: 1, x: 0 }}
                exit={reduceMotion ? { opacity: 0 } : { opacity: 0, x: -16 }}
                transition={{ type: 'spring', stiffness: 360, damping: 30, delay: Math.min(idx * 0.025, 0.4) }}
              >
                <span className="pl-song-num">
                  {idx + 1}
                </span>
                <div className="pl-song-art">
                  <CachedImg song={song} alt={song.title} title={song.title} />
                </div>
                <div className="pl-song-info">
                  <p className="pl-song-title">{song.title}</p>
                  <ArtistLinks song={song} className="pl-song-artist" />
                </div>
                <span className="pl-song-col-dur pl-song-dur">{durStr || '—'}</span>
                <button
                  className="pl-song-remove"
                  aria-label="Quitar de playlist"
                  onClick={(e) => { e.stopPropagation(); handleRemoveSong(song) }}
                >
                  <X size={14} />
                </button>
              </motion.div>
            )
            })}
          </AnimatePresence>
        </div>
      )}
    </div>
  )
}
