import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { Play, Disc3 } from 'lucide-react'
import { motion, AnimatePresence, useReducedMotion } from 'motion/react'
import BackButton from '@shared/components/BackButton'
import { toast } from 'sonner'
import { usePlayerStore } from '@features/player'
import { getAlbum, searchSongs } from '@services/api/ytmusic'
import { lookupAlbumBio } from '@services/api/wikipedia'
import { getReleaseGroupTracklist } from '@services/api/musicbrainz'
import { getAlbumTracksByName } from '@services/api/deezer'
import { AddToPlaylistButton } from '@features/playlists'
import CachedImg from '@shared/components/CachedImg'
import Sidebar from '@shared/components/Sidebar'
import ArtistLinks from '@shared/components/ArtistLinks'
import useCanHover from '@shared/lib/useCanHover'
import { splitArtistNames } from '@shared/lib/artistNames'
import { EASE_OUT } from '@shared/lib/motionTokens'
import type { SongLike } from '@shared/lib/songIdentity'
import type { WikipediaBio } from '@/types/models'
import { warmYouTubeAudio } from '@features/player/lib/ytblob'
import './ArtistPage.css'
import './AlbumPage.css'

type PlayableSong = SongLike & { source?: string | null }

/** Shape del estado de álbum: mezcla respuestas de YT Music con los fallbacks MB/Deezer. */
interface PageAlbum {
  id: string
  title?: string | null
  artist?: string | null
  year?: string | number | null
  thumbUrl?: string | null
  songs: PlayableSong[]
}

// Adelanta la resolución del stream de YouTube antes de que el usuario
// termine de tocar/soltar el click (ver SongCard.jsx para el detalle).
function warmIfYouTube(song: PlayableSong | null | undefined): void {
  if (song?.source === 'youtube' && (song.videoId || song.id)) {
    // borde JS->TS: el id puede llegar como número; la caché lo usa como clave string
    warmYouTubeAudio(String(song.videoId || song.id))
  }
}

function formatDuration(seconds: number | null | undefined): string {
  if (!seconds) return ''
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

/** Normaliza títulos para comparar el campo "album" de un resultado de búsqueda contra el álbum pedido. */
function normalizeForMatch(s: string | null | undefined = '') {
  return String(s)
    .toLowerCase()
    .replace(/\([^)]*\)|\[[^\]]*\]/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

/** Los ids de MusicBrainz son UUID con guiones; los de YT Music nunca lo son. */
const MBID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export default function AlbumPage() {
  const navigate = useNavigate()
  const { albumId } = useParams()
  const [searchParams] = useSearchParams()
  const artistFallback = searchParams.get('artist') || ''
  // MEJORA de performance: ver comentario en HomePage — selector en vez de
  // suscribirse al store completo, para no re-renderizar esta página con
  // cada tick de reproducción.
  const playQueueAt = usePlayerStore((s) => s.playQueueAt)

  const [album, setAlbum] = useState<PageAlbum | null>(null)
  const [loading, setLoading] = useState(true)
  // Info enciclopédica REAL del álbum (Wikipedia). Null = no hay artículo:
  // la tarjeta simplemente no se muestra, nunca se inventa contenido.
  const [wikiInfo, setWikiInfo] = useState<WikipediaBio | null>(null)
  // title/year/thumb viajan en la URL (los pone ArtistPage): el header pinta
  // al instante, sin esperar la respuesta de la API.
  const titleParam = searchParams.get('title') || ''
  const yearParam = searchParams.get('year') || ''
  const thumbParam = searchParams.get('thumb') || ''

  const wikiKeyRef = useRef(`${titleParam}|${artistFallback}`)
  useEffect(() => {
    if (!albumId) return
    const key = `${titleParam}|${artistFallback}`
    if (wikiKeyRef.current !== key) {
      setWikiInfo(null)
      wikiKeyRef.current = key
      lookupAlbumBio(titleParam, artistFallback).then((info) => {
        if (wikiKeyRef.current === key) setWikiInfo(info)
      })
    }
    return () => {
      wikiKeyRef.current = ''
    }
  }, [albumId, titleParam, artistFallback])

  const loadKeyRef = useRef(albumId)
  const loadParamsRef = useRef({ titleParam, artistFallback, yearParam, thumbParam })
  useEffect(() => {
    if (!albumId) return
    // Bandera de montaje: las respuestas async que llegan después del
    // desmontaje (o del cambio de álbum) no deben tocar el estado.
    let active = true
    const params = { titleParam, artistFallback, yearParam, thumbParam }
    if (loadKeyRef.current !== albumId || loadParamsRef.current !== params) {
      setAlbum(null)
      setLoading(true)
      loadKeyRef.current = albumId
      loadParamsRef.current = params
    }

    const load = async () => {
      // Camino normal: YT Music conoce este id (MPREb_…). Para MBIDs ni
      // intentamos getAlbum: el id no existe ahí y sería un pedido al vacío.
      const isMbid = MBID_RE.test(albumId)
      let result = isMbid ? null : await getAlbum(albumId).catch(() => null)

      // Lanzamiento EXCLUSIVO de MusicBrainz (directo, compilación, edición
      // especial): su tracklist real vive en MusicBrainz. La mostramos tal
      // cual es — y cada pista se resuelve contra YT Music recién al
      // reproducirla (resolveTrackOnYt), así no inventamos nada.
      if (!result && isMbid) {
        const mbTracks = await getReleaseGroupTracklist(albumId)
        // Respaldo Deezer: si MusicBrainz conoce el lanzamiento pero no tiene
        // pistas cargadas, la búsqueda "<artista> <álbum>" de Deezer cubre la
        // misma función antes de rendirse al fallback de YT Music.
        const tracks =
          mbTracks.length > 0 ? mbTracks : await getAlbumTracksByName(artistFallback, titleParam)
        const trackSource = mbTracks.length > 0 ? 'musicbrainz' : 'deezer'
        if (!active) return
        if (tracks.length > 0) {
          setAlbum({
            id: albumId,
            title: titleParam || 'Álbum',
            artist: artistFallback || null,
            year: Number(yearParam) || null,
            thumbUrl: thumbParam || null,
            songs: tracks.map((t, i) => ({
              id: `${albumId}:${t.position || i + 1}`,
              title: t.title,
              artist: artistFallback || '',
              artists: artistFallback ? [{ name: artistFallback, artistId: null }] : [],
              album: titleParam || '',
              albumArtUrl: thumbParam || null,
              duration: t.duration,
              videoId: null,
              source: trackSource,
            })),
          })
          setLoading(false)
          return
        }
      }
      // Fallback: lanzamientos que SOLO existen en MusicBrainz (comentary,
      // directos, compilaciones) — su id no existe en YT Music y getAlbum
      // vuelve vacío. Resolvemos las pistas buscando "<artista> <título>".
      if (!result || !Array.isArray(result.songs) || result.songs.length === 0) {
        const query = [artistFallback, result?.title || titleParam].filter(Boolean).join(' ')
        if (query.trim()) {
          const found = await searchSongs(query, 25).catch(() => [])
          if (!active) return
          // FILTRO ESTRICTO: cada resultado de búsqueda trae a qué álbum
          // pertenece. Solo aceptamos pistas cuyo álbum coincida con el
          // pedido — sin esto, la búsqueda rellenaba con las top-songs del
          // artista y TODOS los álbumes mostraban "las mismas 20 canciones,
          // rotadas de posición". Si nada coincide: estado vacío honesto.
          const wanted = normalizeForMatch(result?.title || titleParam)
          const matched = found.filter((s) => s.album && normalizeForMatch(s.album) === wanted)
          if (matched.length > 0) {
            setAlbum({
              id: albumId,
              title: result?.title || titleParam || 'Álbum',
              artist: artistFallback || result?.artist || null,
              year: result?.year || Number(yearParam) || null,
              thumbUrl: matched[0]?.albumArtUrl || result?.thumbUrl || null,
              songs: matched,
            })
            setLoading(false)
            return
          }
        }
      }
      if (active) {
        setAlbum(result)
        setLoading(false)
      }
    }

    load()

    return () => {
      active = false
    }
  }, [albumId, titleParam, artistFallback, yearParam, thumbParam])

  const songs = album?.songs || []
  // El header usa primero lo que vino en la URL: cero espera para pintar.
  const artistName = artistFallback || album?.artist
  const displayTitle = album?.title || titleParam || 'Álbum'
  const displayYear = album?.year || Number(yearParam) || null
  const displayThumb = album?.thumbUrl || thumbParam || null

  /**
   * Resuelve una pista de MusicBrainz (sin videoId) contra YT Music:
   * busca "<artista> <título>" y acepta el primer resultado cuyo título
   * coincida. La pista mostrada sigue siendo la oficial de MB — solo le
   * encontramos una grabación reproducible.
   */
  const resolveTrackOnYt = async (track: PlayableSong): Promise<PlayableSong | null> => {
    if (track.videoId) return track
    const query = [artistName, track.title].filter(Boolean).join(' ')
    const found = await searchSongs(query, 10).catch(() => [])
    const want = normalizeForMatch(track.title)
    const hit =
      found.find((s) => s.videoId && normalizeForMatch(s.title) === want) ||
      (want.length >= 4
        ? found.find((s) => s.videoId && normalizeForMatch(s.title).includes(want))
        : null) ||
      null
    if (!hit) return null
    // El título mostrado queda siendo el de la pista oficial (MB).
    return { ...hit, title: track.title }
  }

  /** Parchea una pista resuelta dentro del estado del álbum. */
  const patchTrack = (resolved: PlayableSong, index: number) => {
    setAlbum((prev) => {
      if (!prev) return prev
      const next = [...prev.songs]
      next[index] = resolved
      return { ...prev, songs: next }
    })
  }

  const handlePlayAll = async () => {
    if (songs.length === 0) return
    const needs = songs.filter((s) => !s.videoId)
    if (needs.length === 0) {
      // Sin resolución pendiente: navegamos ya (el set() síncrono de
      // playQueueAt deja el estado listo antes de este navigate), así
      // nunca se pinta la mini barra en esta página antes de saltar al
      // reproductor principal.
      void playQueueAt(songs, 0).catch(() => {})
      navigate('/player')
      return
    }
    // Pool de resolución con concurrencia limitada: en serie, un directo de
    // 27 pistas tardaba ~30s (una búsqueda por pista, una atrás de otra);
    // con 4 workers baja a ~8s sin castigar a YT Music con decenas de
    // pedidos simultáneos.
    const CONCURRENCY = 4
    const pending = songs.map((s, i) => (!s.videoId ? i : -1)).filter((i) => i >= 0)
    const pendingCount = pending.length
    const resolvedByIndex = new Map<number, PlayableSong>()
    let done = 0
    toast.loading(`Buscando las pistas en YouTube… 0/${pendingCount}`, { id: 'resolve-album' })

    const worker = async () => {
      while (pending.length > 0) {
        const index = pending.shift()
        if (index === undefined) break
        // eslint-disable-next-line no-await-in-loop
        const resolved = await resolveTrackOnYt(songs[index]!)
        done += 1
        toast.loading(`Buscando las pistas en YouTube… ${done}/${pendingCount}`, { id: 'resolve-album' })
        if (resolved) resolvedByIndex.set(index, resolved)
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, pendingCount) }, worker))

    toast.dismiss('resolve-album')
    if (resolvedByIndex.size === 0) {
      toast.error('No pudimos encontrar ninguna pista en YouTube')
      return
    }
    // Un solo re-render: se parchean todas las resueltas juntas y la cola
    // conserva el orden original del álbum.
    setAlbum((prev) => {
      if (!prev) return prev
      return { ...prev, songs: prev.songs.map((s, i) => resolvedByIndex.get(i) || s) }
    })
    const playable = songs.map((s, i) => resolvedByIndex.get(i) || s).filter((s) => s.videoId)
    void playQueueAt(playable, 0).catch(() => {})
    navigate('/player')
  }

  const handlePlayTrack = async (index: number) => {
    const track = songs[index]
    if (!track) return
    if (!track.videoId) {
      toast.loading(`Buscando "${track.title}"…`, { id: 'resolve-track' })
      const resolved = await resolveTrackOnYt(track)
      toast.dismiss('resolve-track')
      if (!resolved) {
        toast.error(`No encontramos "${track.title}" en YouTube`)
        return
      }
      patchTrack(resolved, index)
      void playQueueAt([resolved], 0).catch(() => {})
      navigate('/player')
      return
    }
    void playQueueAt(songs, index).catch(() => {})
    navigate('/player')
  }

  const reduceMotion = useReducedMotion()
  const canHover = useCanHover()

  return (
    <div className="artist-page album-page">
      <Sidebar />

      <BackButton />

      <section
        className="artist-hero"
        style={displayThumb ? ({ '--artist-hero-bg': `url(${displayThumb})` } as CSSProperties) : undefined}
      >
        <motion.div
          className="artist-hero-art album-hero-art"
          initial={reduceMotion ? undefined : { opacity: 0, scale: 1.06 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.45, ease: EASE_OUT }}
        >
          {displayThumb ? <CachedImg src={displayThumb} alt="" /> : <Disc3 size={36} />}
        </motion.div>
        <div className="artist-hero-details">
          <motion.p
            className="home-section-kicker"
            initial={reduceMotion ? undefined : { opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.35, ease: EASE_OUT }}
          >
            Álbum
          </motion.p>
          <motion.h1
            initial={reduceMotion ? undefined : { opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, delay: 0.05, ease: EASE_OUT }}
          >
            {loading && !displayTitle ? 'Cargando…' : displayTitle}
          </motion.h1>
          {(artistName || displayYear) && (
            <motion.div
              className="artist-info-meta"
              initial={reduceMotion ? undefined : { opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.35, delay: 0.1, ease: EASE_OUT }}
            >
              {artistName && (
                // El álbum puede tener varios artistas combinados (p. ej.
                // "Drake & Yebba"); cada uno navega a su propia página.
                splitArtistNames(artistName).map((name, i) => (
                  <span
                    key={`${name}-${i}`}
                    className="album-artist-chip"
                    onClick={() => navigate(`/artist/${encodeURIComponent(name)}`)}
                  >
                    {name}
                  </span>
                ))
              )}
              {displayYear && <span>{displayYear}</span>}
              {songs.length > 0 && <span>{songs.length} canciones</span>}
            </motion.div>
          )}
          <motion.button
            className="playlist-play-all album-play-all"
            onClick={handlePlayAll}
            disabled={songs.length === 0}
            initial={reduceMotion ? undefined : { opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.38, delay: 0.15, ease: EASE_OUT }}
            whileHover={canHover && songs.length > 0 ? { scale: 1.03 } : undefined}
            whileTap={songs.length > 0 ? { scale: 0.96 } : undefined}
          >
            <Play size={15} fill="currentColor" />
            Reproducir álbum
          </motion.button>
        </div>
      </section>

      {/* Info oficial del álbum (Wikipedia) — solo si existe un artículo
          verificado; si no, no se muestra nada. */}
      {wikiInfo?.summary && (
        <motion.section
          className="artist-songs-section"
          initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.35, ease: EASE_OUT }}
        >
          <div className="artist-bio-card">
            <p className="artist-bio">{wikiInfo.summary}</p>
            <div className="artist-bio-footer">
              {wikiInfo.translated && (
                <span className="artist-bio-translated">Traducido automáticamente</span>
              )}
              {wikiInfo.wikipediaUrl && (
                <a href={wikiInfo.wikipediaUrl} target="_blank" rel="noreferrer" className="artist-bio-link">
                  Ver en Wikipedia
                </a>
              )}
            </div>
          </div>
        </motion.section>
      )}

      <section className="artist-songs-section">
        <AnimatePresence mode="wait">
          {loading ? (
            <motion.p key="loading" className="home-empty" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }}>
              Buscando el álbum…
            </motion.p>
          ) : songs.length === 0 ? (
            <motion.p key="empty" className="home-empty" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }}>
              No pudimos encontrar las canciones de este álbum.
            </motion.p>
          ) : (
            <motion.div key="tracks" className="album-track-list" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }}>
              {songs.map((track, index) => (
                <motion.div
                  key={track.id}
                  className="album-track-row"
                  onClick={() => handlePlayTrack(index)}
                  onPointerDown={() => warmIfYouTube(track)}
                  onPointerEnter={() => warmIfYouTube(track)}
                  initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.3, ease: EASE_OUT, delay: Math.min(index * 0.02, 0.3) }}
                  whileHover={canHover ? { x: 4 } : undefined}
                  whileTap={{ scale: 0.99 }}
                >
                  <span className="album-track-number">{index + 1}</span>
                  {track.albumArtUrl && <CachedImg song={track} alt="" className="artist-song-art" />}
                  <div className="artist-song-info">
                    <p className="song-card-title">{track.title}</p>
                    <ArtistLinks song={track} className="song-card-artist" />
                  </div>
                  <span className="album-track-duration">{formatDuration(track.duration)}</span>
                  {/* Pistas aún sin resolver (MusicBrainz) no se pueden agregar
                      a una playlist: todavía no tienen videoId. */}
                  {track.videoId && (
                    <div className="artist-song-actions" onClick={(e) => e.stopPropagation()}>
                      <AddToPlaylistButton song={track} />
                    </div>
                  )}
                </motion.div>
              ))}
            </motion.div>
          )}
        </AnimatePresence>
      </section>
    </div>
  )
}
