import { useMemo, useState, useEffect, useRef, type CSSProperties } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { Play, ChevronDown, Shuffle } from 'lucide-react'
import BackButton from '@shared/components/BackButton'
import { motion, AnimatePresence, useReducedMotion } from 'motion/react'
import { EASE_OUT } from '@shared/lib/motionTokens'
import { usePlayerStore } from '@features/player'
import { getFavoriteSongs, useAuthStore } from '@features/auth'
import { usePlaylistsStore } from '@features/playlists'
import { lookupArtistInfo } from '@services/api/audiodb'
import { lookupArtistBio } from '@services/api/wikipedia'
import { searchArtists, getArtist, searchSongs } from '@services/api/ytmusic'
import {
  lookupArtistPhoto,
  readArtistTheme,
  writeArtistTheme,
  fetchArtistDiscography,
  type ArtistTheme,
  type Release,
} from '@features/artists/lib/artists'
import { extractDominantColor, buildAdaptiveTheme } from '@features/lyrics/engine/theme/extractPalette'
import { getCachedAssetUrl } from '@shared/lib/cacheManager'
import { AddToPlaylistButton } from '@features/playlists'
import CachedImg from '@shared/components/CachedImg'
import Sidebar from '@shared/components/Sidebar'
import ArtistLinks from '@shared/components/ArtistLinks'
import { splitArtistNames } from '@shared/lib/artistNames'
import { translateGenre } from '@shared/lib/genres'
import { normalizeTitle, dedupeSongs, type SongLike } from '@shared/lib/songIdentity'
import type { AlbumBasic, ArtistInfo, Song, WikipediaBio } from '@/types/models'
import { warmYouTubeAudio } from '@features/player/lib/ytblob'
import './ArtistPage.css'

// Adelanta la resolución del stream de YouTube antes de que el usuario
// termine de tocar/soltar el click (ver SongCard.jsx para el detalle).
function warmIfYouTube(song: SongLike & { source?: string | null } | null | undefined): void {
  if (song?.source === 'youtube' && (song.videoId || song.id)) {
    // borde JS->TS: el id puede llegar como número; la caché lo usa como clave string
    warmYouTubeAudio(String(song.videoId || song.id))
  }
}

// normalizeTitle: minúsculas, sin sufijos entre paréntesis/corchetes ("(Deluxe)",
// "[Explicit]", "(Remastered 2011)") y sin puntuación — así "Evolution" venido de
// YT Music y "Evolution (Deluxe Edition)" venido de MusicBrainz caen en la MISMA
// tarjeta en vez de duplicarse como dos discos distintos. Vive en songIdentity.js
// para compartirla con el dedupe de canciones (favoritos/recientes/playlists).

/**
 * Fila horizontal estilo Apple Music: cards verticales con arte cuadrado
 * arriba y título debajo. El slot de arte existe SIEMPRE (cargue la
 * portada, falle o no exista) — así todas las cards quedan idénticas y
 * alineadas, sin rectángulos desbordados ni huecos según qué imagen
 * respondió.
 *
 * IMPORTANTE: este componente vive FUERA de ArtistPage a propósito. Antes
 * estaba definido adentro del cuerpo de ArtistPage, lo que creaba una
 * función (= un tipo de componente) nueva en CADA render de ArtistPage.
 * React no reconciliaba eso como "el mismo ReleaseGrid, releases nuevos":
 * lo veía como un componente distinto y desmontaba + volvía a montar TODA
 * la grilla — cada CachedImg de portada perdía su estado, volvía a pedir
 * la imagen a /api/imgproxy desde cero y reiniciaba el fade-in. Resultado:
 * las portadas de la discografía "pestañaban" en cada render de la página
 * (terminaba de cargar la bio, resolvía el tema de color, etc.), sin
 * límite, y se disparaban pedidos repetidos al proxy de imágenes.
 */
/** Un lanzamiento de la discografía unificada (MusicBrainz + YT Music). */
interface CatalogRelease {
  id: string
  playable: boolean
  title: string
  type: string
  secondaryTypes: string[]
  year?: string | number | null
  date: string
  thumbUrl?: string | null
}

interface ReleaseGridProps {
  title: string
  releases: CatalogRelease[]
  onPlay: (release: CatalogRelease) => void
}

function ReleaseGrid({ title, releases, onPlay }: ReleaseGridProps) {
  if (!releases || releases.length === 0) return null
  return (
    <section className="artist-songs-section">
      <div className="home-library-header">
        <div>
          <h2 className="home-section-title">{title}</h2>
        </div>
      </div>
      <div className="release-row">
        {releases.map((release) => (
          <div
            key={release.id}
            className="release-card"
            onClick={() => onPlay(release)}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                onPlay(release)
              }
            }}
          >
            <div className="release-card-art">
              <CachedImg src={release.thumbUrl} alt="" title={release.title} />
            </div>
            <p className="release-card-title">{release.title}</p>
            <p className="release-card-sub">
              {[release.type !== 'Album' ? release.type : null, release.year].filter(Boolean).join(' · ')}
            </p>
          </div>
        ))}
      </div>
    </section>
  )
}

export default function ArtistPage() {
  const navigate = useNavigate()
  const { artistName } = useParams()
  const [searchParams] = useSearchParams()
  const artistIdParam = searchParams.get('id')
  // MEJORA: mismo fix que HomePage/DiscoverPage — esta línea sí ya usaba
  // selector para getRecentlyPlayed pero playQueueAt seguía suscribiendo al
  // store completo (anulando el beneficio del selector de abajo).
  const playQueueAt = usePlayerStore((s) => s.playQueueAt)
  const currentUser = useAuthStore((s) => s.currentUser)
  const getRecentlyPlayed = usePlayerStore((s) => s.getRecentlyPlayed)
  const playlists = usePlaylistsStore((s) => s.playlists)
  const reduceMotion = useReducedMotion()

  const [artistInfo, setArtistInfo] = useState<ArtistInfo | null>(null)
  const [wikiInfo, setWikiInfo] = useState<WikipediaBio | null>(null)
  // Biografía nativa de YT Music (el "about" del canal del artista) — fuente principal
  // de bio ahora; Wikipedia/AudioDB quedan como respaldo solo si YT Music no la tiene.
  const [ytBio, setYtBio] = useState<string | null>(null)
  // Distingue "todavía no llegó la respuesta" de "llegó y no hay bio" —
  // sin esto, un artista sin biografía disponible (Wikipedia no tiene
  // artículo real sobre él y AudioDB tampoco lo indexa) dejaba un hueco
  // vacío en la tarjeta sin ninguna explicación.
  const [bioLoading, setBioLoading] = useState(true)
  const [ytAlbums, setYtAlbums] = useState<AlbumBasic[]>([])
  const [ytSingles, setYtSingles] = useState<AlbumBasic[]>([])
  const [albumsLoading, setAlbumsLoading] = useState(true)
  const [themeColors, setThemeColors] = useState<ArtistTheme | null>(null)
  const [songs, setSongs] = useState<Song[]>([])
  const [songsLoading, setSongsLoading] = useState(true)
  // Distingue "no encontramos más canciones" (respuesta real, catálogo
  // corto) de "no pudimos pedirle nada a YT Music" (fetch falló incluso
  // después de sus reintentos). Antes ambos casos caían en el mismo
  // estado vacío silencioso — la página parecía simplemente "no cargar"
  // sin ninguna pista de qué pasó ni forma de reintentar.
  const [songsError, setSongsError] = useState<unknown>(null)
  const [retryNonce, setRetryNonce] = useState(0)
  const [discography, setDiscography] = useState<Release[]>([])
  const [discographyLoading, setDiscographyLoading] = useState(true)
  // Expandable biography state
  const [bioExpanded, setBioExpanded] = useState(false)
  const decodedArtist = decodeURIComponent(artistName || '')
  // Prioridad: YT Music (su propia bio, cuando el canal del artista tiene una) primero;
  // Wikipedia y AudioDB quedan como respaldo, solo si YT Music no trae nada.
  const bioSource = ytBio ? 'ytmusic' : wikiInfo?.summary ? 'wikipedia' : artistInfo?.biography ? 'audiodb' : null
  const bioText = ytBio || wikiInfo?.summary || artistInfo?.biography || ''
  // Clamp bio if it exceeds threshold
  const BIO_CLAMP_THRESHOLD = 220
  const bioNeedsClamp = bioText.length > BIO_CLAMP_THRESHOLD

  /** Validates metadata tags to ignore placeholder values like "0" or "N/A" */
  const isMeaningfulTag = (value: unknown): boolean => {
    if (value === null || value === undefined) return false
    const normalized = String(value).trim()
    if (!normalized) return false
    return !/^(0+|n\/?a|null|undefined|unknown|desconocido)$/i.test(normalized)
  }
  const [artistThumb, setArtistThumb] = useState<string | null>(null)
  // Songs from the user's library by this artist. Se junta de tres fuentes
  // (favoritos, recientes, playlists) y se deduplica por identidad canónica
  // (título+artista), no por id exacto: la misma canción puede haber quedado
  // guardada bajo distintos videoId de YT Music en cada fuente, y sin esto
  // aparecía dos veces con carátulas distintas (bug reportado: "Andrea" duplicada).
  const librarySongs = useMemo(() => {
    const nameLower = decodedArtist.toLowerCase().trim()
    const matchesArtist = (song: SongLike | null | undefined) => {
      const inArtists =
        Array.isArray(song?.artists) &&
        song.artists.some((a) => String(a?.name || '').toLowerCase().trim() === nameLower)
      const inArtistField = String(song?.artist || '').toLowerCase().trim() === nameLower
      return inArtists || inArtistField
    }
    const candidates = [
      ...getFavoriteSongs(currentUser),
      ...getRecentlyPlayed(),
      ...playlists.flatMap((p) => p.songs || []),
    ].filter(matchesArtist)
    return dedupeSongs(candidates)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [decodedArtist, currentUser, playlists])

  useEffect(() => {
    if (!decodedArtist) return
    let active = true
    // Reset state when navigating to a new artist
    setArtistInfo(null)
    setWikiInfo(null)
    setYtBio(null)
    setBioLoading(true)
    setBioExpanded(false)
    setYtAlbums([])
    setYtSingles([])
    setAlbumsLoading(true)
    setThemeColors(null)
    setSongsError(null)

    let infoDone = false
    let wikiDone = false
    let ytBioDone = false
    const checkBioSettled = () => {
      if (infoDone && wikiDone && ytBioDone && active) setBioLoading(false)
    }

    // Páginas de artistas "combinados" (p. ej. "Drake & Yebba" en una
    // colaboración) casi nunca tienen su propio artículo/ficha en
    // AudioDB o Wikipedia — buscar el string completo ahí falla siempre.
    // Antes se reintentaba candidato POR candidato EN SERIE: hasta N
    // round-trips sumados antes del primer resultado. Ahora todas las
    // variantes salen en paralelo y gana la primera con resultado,
    // respetando el orden de prioridad original.
    const artistCandidates = [decodedArtist, ...splitArtistNames(decodedArtist).filter((n) => n !== decodedArtist)]

    const findFirst = async <T,>(lookupFn: (candidate: string) => Promise<T | null>): Promise<T | null> => {
      const results = await Promise.all(
        artistCandidates.map((candidate) => lookupFn(candidate).catch(() => null)),
      )
      return results.find(Boolean) || null
    }

    // AudioDB se conserva solo por sus campos estructurados (género, país, año de
    // formación) que ni YT Music ni Wikipedia dan — ya no es fuente de bio salvo que
    // YT Music y Wikipedia fallen los dos.
    findFirst(lookupArtistInfo).then((info) => {
      if (active) setArtistInfo(info)
    }).finally(() => {
      infoDone = true
      checkBioSettled()
    })

    // Wikipedia queda como respaldo de biografía, no como fuente principal:
    // resolveArtist() (más abajo) ya pide la bio nativa de YT Music en la misma
    // llamada que trae canciones/álbumes, y esa se muestra primero si existe.
    findFirst(lookupArtistBio).then((info) => {
      if (active) setWikiInfo(info)
    }).finally(() => {
      wikiDone = true
      checkBioSettled()
    })

    // Tema del artista cacheado por nombre: los colores dominantes son
    // deterministas para una misma foto, así que recalcularlos en cada
    // visita solo servía un flash de fondo genérico + decode de imagen
    // entera antes de ver el tinte del hero. Se lee al montar (pinta ya)
    // y se refresca cuando la foto termina de cargar (por si cambió).
    // (Caché consolidada con LRU en artists.js — ver readArtistTheme.)
    const cachedTheme = readArtistTheme(decodedArtist)
    if (cachedTheme?.accent && cachedTheme?.accentDim) setThemeColors(cachedTheme)

    // Fetch unified artist photo — también por candidatos: para nombres
    // combinados el string completo suele caer en una fuente rara (logo
    // circular de AudioDB/Deezer) antes que en la foto real del artista.
    findFirst(lookupArtistPhoto).then((thumb) => {
      if (!active || !thumb) return
      setArtistThumb(thumb)
      // getCachedAssetUrl (mismo caché que usa CachedImg/useCachedImageSrc
      // para pintar la foto del hero) resuelve a una blob: URL a partir de
      // un fetch() propio — evita pedir la imagen DOS VECES por la red (antes,
      // esta extracción de color hacía su propio <img crossOrigin> aparte del
      // que ya pinta CachedImg) y de paso evita el canvas "tainted" en fuentes
      // sin CORS habilitado (AudioDB, Wikipedia): el blob ya lo trajo fetch()
      // del lado de JS, así que getImageData funciona sin importar el origen.
      getCachedAssetUrl(thumb, thumb, 'image').then((resolvedSrc) => {
        if (!active) return
        const img = new Image()
        img.src = resolvedSrc
        img.onload = () => {
          if (!active) return
          const palette = extractDominantColor(img)
          if (!palette) return
          const theme = buildAdaptiveTheme(palette.rgb)
          setThemeColors(theme)
          writeArtistTheme(decodedArtist, theme)
        }
      })
    })

    // Discografía con failover automático: MusicBrainz primero (mejor
    // tipado + rarezas), Deezer como respaldo si MB falla o no conoce al
    // artista. Ver fetchArtistDiscography en artists.js.
    setDiscography([])
    setDiscographyLoading(true)
    fetchArtistDiscography(decodedArtist)
      .then(({ releases }) => {
        if (active) setDiscography(releases)
      })
      .catch(() => {})
      .finally(() => {
        if (active) setDiscographyLoading(false)
      })

    setSongsLoading(true)
    // Resolve artist ID and fetch songs, albums and bio nativa — todo en la misma
    // llamada a YT Music, en vez de una llamada aparte solo para la bio.
    // `lastError` se guarda (no se relanza) en cada paso: cada llamada a
    // YT Music ya trae sus propios reintentos con backoff (ver
    // fetchJson en services/api/ytmusic.js) — acá solo se registra el
    // último fallo, para poder distinguir "en serio no se pudo pedir
    // nada" de "se pidió bien y el artista no tiene más canciones".
    let lastError: unknown = null
    const resolveArtist = async () => {
      let id = artistIdParam
      if (!id) {
        // Mismo criterio que la bio: el nombre completo puede no existir como
        // artista en YT Music (colaboraciones "Charli xcx & Billie Eilish",
        // créditos de featuring) — se prueban los candidatos en orden y gana
        // el primero con match EXACTO. Sin esto, la página caía al fallback
        // de búsqueda y quedaba casi vacía (una foto circular rara + 1 tema).
        for (const candidate of artistCandidates) {
          // eslint-disable-next-line no-await-in-loop
          const matches = await searchArtists(candidate, 5).catch((err) => {
            lastError = err
            return []
          })
          const nameLower = candidate.toLowerCase().trim()
          const exactMatch = matches.find((m) => String(m?.name || '').toLowerCase().trim() === nameLower)
          if (exactMatch?.artistId) {
            id = exactMatch.artistId
            lastError = null
            break
          }
        }
      }
      if (id) {
        const result = await getArtist(id).catch((err) => {
          lastError = err
          return null
        })
        if (result) {
          lastError = null
          return { tracks: result.songs || [], ytAlbums: result.albums || [], ytSingles: result.singles || [], ytBio: result.description || null }
        }
      }
      // Fallback: search songs by exact name
      const fallbackTracks = await searchSongs(decodedArtist, 12).catch((err) => {
        lastError = err
        return []
      })
      if (fallbackTracks.length) lastError = null
      return { tracks: fallbackTracks, ytAlbums: [], ytSingles: [], ytBio: null }
    }

    resolveArtist().then(({ tracks, ytAlbums, ytSingles, ytBio: nativeBio }) => {
      if (!active) return
      setSongs(tracks || [])
      setSongsLoading(false)
      // Solo se marca error real cuando, después de todos los intentos y
      // fallbacks, no llegó NADA — un artista con catálogo corto (0
      // canciones) pero sin ningún fallo de red no debe mostrar el
      // mensaje de error, solo el de "no encontramos más canciones".
      setSongsError(!tracks?.length && lastError ? lastError : null)
      setYtAlbums(ytAlbums || [])
      setYtSingles(ytSingles || [])
      setAlbumsLoading(false)
      setYtBio(nativeBio)
    }).finally(() => {
      ytBioDone = true
      checkBioSettled()
    })

    return () => {
      active = false
    }
  }, [decodedArtist, artistIdParam, retryNonce])

  const handleRetrySongs = () => setRetryNonce((n) => n + 1)

  // Altura natural de la bio (puede cambiar con la carga de la fuente,
  // resize o rotación): alimenta --bio-h, el techo EXACTO al que anima
  // max-height al expandir (ver ArtistPage.css). Sin medición real, el
  // techo fijo de 60rem hacía la expansión instantánea y el colapso
  // arrancando tarde — asimetría fea del toggle "Leer más".
  const bioWrapRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const wrap = bioWrapRef.current
    const p = wrap?.querySelector<HTMLElement>('.artist-bio')
    if (!wrap || !p) return
    const apply = () => wrap.style.setProperty('--bio-h', `${p.offsetHeight}px`)
    apply()
    const ro = new ResizeObserver(apply)
    ro.observe(p)
    return () => ro.disconnect()
  }, [bioText])

  const dedupedYtAlbums = useMemo(() => {
    const byKey = new Map<string, AlbumBasic>()
    for (const album of ytAlbums) {
      const key = normalizeTitle(album.title)
      if (!key) continue
      const existing = byKey.get(key)
      if (!existing) {
        byKey.set(key, album)
        continue
      }
      const existingIsClean = String(existing.title || '').trim().length <= String(album.title || '').trim().length
      if (!existingIsClean) byKey.set(key, album)
    }
    return [...byKey.values()]
  }, [ytAlbums])

  const dedupedYtSingles = useMemo(() => {
    const byKey = new Map<string, AlbumBasic>()
    for (const single of ytSingles) {
      const key = normalizeTitle(single.title)
      if (!key) continue
      const existing = byKey.get(key)
      if (!existing) {
        byKey.set(key, single)
        continue
      }
      const existingIsClean = String(existing.title || '').trim().length <= String(single.title || '').trim().length
      if (!existingIsClean) byKey.set(key, single)
    }
    return [...byKey.values()]
  }, [ytSingles])

  const unifiedDiscography = useMemo(() => {
    const byKey = new Map<string, CatalogRelease>()
    for (const release of discography) {
      const key = normalizeTitle(release.title)
      if (!key) continue
      byKey.set(key, {
        id: release.mbid,
        title: release.title,
        type: release.type,
        secondaryTypes: release.secondaryTypes || [],
        year: release.firstReleaseDate ? release.firstReleaseDate.slice(0, 4) : null,
        // '0000-01-01', NO '9999-12-31': un release sin fecha tiene que
        // ordenar como el MÁS VIEJO, no como el más nuevo. Con '9999' un
        // lanzamiento sin fecha conocida (típico en MusicBrainz para EPs o
        // rarezas viejas) se colaba primero en la lista y terminaba elegido
        // como featuredRelease ("Último lanzamiento") en vez del álbum
        // realmente más reciente.
        date: release.firstReleaseDate || '0000-01-01',
        thumbUrl: release.coverArtUrl,
        playable: false
      })
    }

    for (const album of dedupedYtAlbums) {
      const key = normalizeTitle(album.title)
      if (!key) continue
      const existing = byKey.get(key)
      
      if (existing) {
        existing.id = album.id
        existing.playable = true
        // La portada de YT Music siempre existe y carga directo desde el CDN
        // de google; la de MusicBrainz pasa por Cover Art Archive vía imgproxy
        // (lento, y para muchos release-groups directamente no hay tapa →
        // fallback). Si hay YT, gana — la de MB queda solo como último recurso.
        if (album.thumbUrl) {
          existing.thumbUrl = album.thumbUrl
        }
      } else {
        byKey.set(key, {
          id: album.id,
          playable: true,
          title: album.title,
          type: 'Album',
          secondaryTypes: [],
          year: album.year,
          date: album.year ? `${album.year}-12-31` : '0000-01-01', // ver comentario arriba
          thumbUrl: album.thumbUrl
        })
      }
    }
    
    // Los singles de YT Music van AL FINAL y solo si el título no existe ya:
    // MusicBrainz suele traerlos con el tipo correcto, y un single nunca
    // debe pisar a un álbum que compartiera título normalizado.
    for (const single of dedupedYtSingles) {
      const key = normalizeTitle(single.title)
      if (!key || byKey.has(key)) continue
      byKey.set(key, {
        id: single.id,
        playable: true,
        title: single.title,
        type: 'Single',
        secondaryTypes: [],
        year: single.year,
        date: single.year ? `${single.year}-12-31` : '0000-01-01', // ver comentario arriba
        thumbUrl: single.thumbUrl,
      })
    }

    return [...byKey.values()].sort((a, b) => b.date.localeCompare(a.date))
  }, [dedupedYtAlbums, dedupedYtSingles, discography])

  const featuredRelease = unifiedDiscography[0] || null
  const catalogRest = featuredRelease ? unifiedDiscography.slice(1) : []
  
  // Categorías EXCLUSIVAS (como Apple Music): un lanzamiento en vivo o
  // compilación no puede aparecer también en Álbumes/Sencillos — antes
  // "Live at Third Man Records" (EP + Live) salía DUPLICADO en dos secciones.
  const isLiveOrComp = (r: CatalogRelease): boolean =>
    r.secondaryTypes.includes('Live') || r.secondaryTypes.includes('Compilation')
  const studioAlbums = catalogRest.filter((r) => r.type === 'Album' && !isLiveOrComp(r))
  const singlesAndEps = catalogRest.filter((r) => (r.type === 'Single' || r.type === 'EP') && !isLiveOrComp(r))
  const liveAlbums = catalogRest.filter((r) => r.secondaryTypes.includes('Live'))
  const compilations = catalogRest.filter((r) => r.secondaryTypes.includes('Compilation'))

  const handlePlay = (song: SongLike | null | undefined, list: SongLike[]) => {
    const index = list.findIndex((item) => item.id === song?.id)
    // Navegamos sin esperar playQueueAt (ver mismo comentario en HomePage):
    // el set() síncrono ya deja song/currentIndex listos antes de este
    // navigate, así que nunca se llega a pintar la mini barra acá.
    void playQueueAt(list, index === -1 ? 0 : index).catch(() => {})
    navigate('/player')
  }

  // TODA la discografía es accesible: los lanzamientos con id de YT Music
  // abren su página normal; los exclusivos de MusicBrainz (Track by Track
  // Commentary, directos...) abren IGUAL — ahí la tracklist real viene de
  // MusicBrainz y cada pista se resuelve contra YT al reproducirla.
  // title/year/thumb viajan en la URL para que el header pinte al instante.
  const handlePlayAlbum = (album: CatalogRelease) => {
    navigate(
      `/album/${encodeURIComponent(album.id)}?artist=${encodeURIComponent(decodedArtist)}&title=${encodeURIComponent(album.title || '')}&year=${album.year || ''}&thumb=${encodeURIComponent(album.thumbUrl || '')}`,
    )
  }

  return (
    <div className="artist-page">
      <Sidebar />

      <BackButton />

      <section
        key={decodedArtist}
        className="artist-hero"
        style={{
          // La foto SIEMPRE va como fondo cuando existe — antes, en cuanto
          // el color dominante terminaba de calcularse (o venía de caché,
          // ¡que se lee al montar!), esta rama pisaba --artist-hero-bg con
          // un gradiente plano de 2 colores y el retrato desaparecía. El
          // tema extraído ahora solo aporta el acento (botones, links,
          // scrim de .artist-hero::after), nunca reemplaza la foto.
          ...(artistThumb ? ({ '--artist-hero-bg': `url(${artistThumb})` } as CSSProperties) : {}),
          ...(
            themeColors
              ? ({ '--accent': themeColors.accent, '--accent-strong': themeColors.accentStrong } as CSSProperties)
              : {}
          ),
        }}
      >
        {artistThumb && (
          <motion.div
            className="artist-hero-art"
            initial={reduceMotion ? undefined : { opacity: 0, scale: 1.06 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.45, ease: EASE_OUT }}
          >
            <CachedImg src={artistThumb} alt="" />
          </motion.div>
        )}
        <div className="artist-hero-details">
          {/* Entrada del hero: stagger corto (30-60ms entre piezas) con
              ease-out — la página "llega" en lugar de aparecer. El key del
              section de arriba la re-dispara al cambiar de artista. */}
          <motion.h1
            initial={reduceMotion ? undefined : { opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, delay: 0.05, ease: EASE_OUT }}
          >
            {decodedArtist}
          </motion.h1>

          <motion.div
            className="artist-hero-actions"
            initial={reduceMotion ? undefined : { opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.38, delay: 0.12, ease: EASE_OUT }}
          >
            <button className="btn-hero-play" onClick={() => songs.length > 0 && handlePlay(songs[0], songs)}>
              <Play size={20} fill="currentColor" />
              <span>Reproducir</span>
            </button>
            <button className="btn-hero-shuffle" onClick={() => {
              if (songs.length === 0) return;
              const shuffled = songs.toSorted(() => Math.random() - 0.5)
              handlePlay(shuffled[0], shuffled)
            }}>
              <Shuffle size={18} />
            </button>
          </motion.div>

          {artistInfo && (
            <motion.div
              className="artist-info-meta"
              initial={reduceMotion ? undefined : { opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.35, delay: 0.18, ease: EASE_OUT }}
            >
              {isMeaningfulTag(artistInfo.genre) && <span>{translateGenre(artistInfo.genre)}</span>}
              {isMeaningfulTag(artistInfo.country) && <span>{artistInfo.country}</span>}
              {isMeaningfulTag(artistInfo.yearFormed) && <span>{artistInfo.yearFormed}</span>}
            </motion.div>
          )}
          {bioLoading && !bioText ? (
            <div className="artist-bio-card artist-bio-skeleton" aria-hidden="true">
              {[92, 78, 55].map((w, i) => (
                <motion.div
                  key={w}
                  className="artist-bio-skeleton-line"
                  style={{ width: `${w}%` }}
                  initial={reduceMotion ? undefined : { opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ duration: 0.3, delay: i * 0.06, ease: 'easeOut' }}
                />
              ))}
            </div>
          ) : (
            <AnimatePresence mode="wait" initial={false}>
              {bioText ? (
                <motion.div
                  key="bio-content"
                  className="artist-bio-card"
                  initial={reduceMotion ? undefined : { opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.35, ease: 'easeOut' }}
                >
                  <div
                    ref={bioWrapRef}
                    className={`artist-bio-wrap ${bioNeedsClamp && !bioExpanded ? 'is-collapsed' : 'is-expanded'}`}
                  >
                    <p className="artist-bio">{bioText}</p>
                  </div>
                  <div className="artist-bio-footer">
                    {/* Expand button */}
                    {bioNeedsClamp && (
                      <button
                        type="button"
                        className="artist-bio-toggle"
                        onClick={() => setBioExpanded((v) => !v)}
                        aria-expanded={bioExpanded}
                      >
                        {bioExpanded ? 'Mostrar menos' : 'Leer más'}
                        <ChevronDown size={14} className={`artist-bio-chevron ${bioExpanded ? 'flipped' : ''}`} />
                      </button>
                    )}
                    {bioSource === 'wikipedia' && wikiInfo?.translated && (
                      <span className="artist-bio-translated">Traducido automáticamente</span>
                    )}
                    {bioSource === 'wikipedia' && wikiInfo?.wikipediaUrl && (
                      <a href={wikiInfo.wikipediaUrl} target="_blank" rel="noreferrer" className="artist-bio-link">
                        Ver en Wikipedia
                      </a>
                    )}
                  </div>
                </motion.div>
              ) : (
                /* Sin esto, un artista sin biografía en ninguna fuente dejaba
                   la tarjeta con un hueco vacío sin explicación (ver bug de
                   Wikipedia devolviendo la bio de OTRO artista, ya corregido:
                   esto es lo que queda cuando, correctamente, no encuentra
                   nada en vez de inventar o mostrar algo incorrecto). */
                <motion.div
                  key="bio-empty"
                  className="artist-bio-card artist-bio-card--empty"
                  initial={reduceMotion ? undefined : { opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ duration: 0.3, ease: 'easeOut' }}
                >
                  <p className="artist-bio artist-bio--muted">
                    Todavía no tenemos una biografía para este artista.
                  </p>
                </motion.div>
              )}
            </AnimatePresence>
          )}
        </div>
      </section>

      {librarySongs.length > 0 && (
        <section className="artist-songs-section">
          <div className="home-library-header">
            <div>
              <p className="home-section-kicker">Tu biblioteca</p>
              <h2 className="home-section-title">Ya tenés de este artista</h2>
            </div>
          </div>
          <div className="artist-song-grid">
            {librarySongs.map((song) => (
              <div
                key={song.id}
                className="artist-song-card artist-song-card--muted"
                onClick={() => handlePlay(song, librarySongs)}
                onPointerDown={() => warmIfYouTube(song)}
                onPointerEnter={() => warmIfYouTube(song)}
              >
                {song.albumArtUrl && <CachedImg song={song} alt="" className="artist-song-art" />}
                <div className="artist-song-info">
                  <p className="song-card-title">{song.title}</p>
                  <p className="song-card-artist">{song.album || 'Sencillo'}</p>
                </div>
                <div className="artist-song-actions">
                  <Play size={14} />
                  <div onClick={(e) => e.stopPropagation()}>
                    <AddToPlaylistButton song={song} />
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="artist-songs-section">
        <div className="home-library-header">
          <div>
            <p className="home-section-kicker">Canciones</p>
            <h2 className="home-section-title">Más de este artista</h2>
          </div>
        </div>

        {songsLoading ? (
          <div className="artist-song-grid" aria-hidden="true">
            {[1, 2, 3, 4, 5, 6].map((k) => (
              <motion.div
                key={k}
                className="artist-song-card artist-song-card--muted artist-song-card--skeleton"
                initial={reduceMotion ? undefined : { opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.3, delay: k * 0.04, ease: 'easeOut' }}
              >
                <div className="artist-song-art artist-song-art--skeleton" />
                <div className="artist-song-info">
                  <div className="artist-skeleton-line" style={{ width: '70%' }} />
                  <div className="artist-skeleton-line" style={{ width: '45%', marginTop: '0.5rem' }} />
                </div>
              </motion.div>
            ))}
          </div>
        ) : songs.length === 0 && songsError ? (
          <div className="home-empty">
            <p>No pudimos cargar las canciones de este artista. Puede ser un problema momentáneo de conexión.</p>
            <button type="button" className="page-back" onClick={handleRetrySongs} style={{ marginTop: '0.75rem' }}>
              Reintentar
            </button>
          </div>
        ) : songs.length === 0 ? (
          <p className="home-empty">No encontramos más canciones de este artista.</p>
        ) : (
          <div className="artist-song-grid">
            {songs.map((track, i) => (
              <motion.div
                key={track.id}
                className="artist-song-card artist-song-card--muted"
                onClick={() => handlePlay(track, songs)}
                onPointerDown={() => warmIfYouTube(track)}
                onPointerEnter={() => warmIfYouTube(track)}
                initial={reduceMotion ? undefined : { opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.3, delay: Math.min(i, 12) * 0.03, ease: 'easeOut' }}
              >
                {track.albumArtUrl && <CachedImg song={track} alt="" className="artist-song-art" />}
                <div className="artist-song-info">
                  <p className="song-card-title">{track.title}</p>
                  <ArtistLinks song={track} className="song-card-artist" />
                </div>
                <div className="artist-song-actions">
                  <Play size={14} />
                  <div onClick={(e) => e.stopPropagation()}>
                    <AddToPlaylistButton song={track} />
                  </div>
                </div>
              </motion.div>
            ))}
          </div>
        )}
      </section>

      {/* Featured Release */}
      {(albumsLoading || discographyLoading) && unifiedDiscography.length === 0 ? (
        // Skeleton de discografía: antes esta sección entera no existía
        // mientras cargaba (a diferencia de "Canciones", que sí tiene
        // skeleton) — la página "saltaba" de golpe cuando llegaban los
        // datos. Mismo lenguaje visual (shimmer) que el resto de la página.
        <section className="artist-songs-section">
          <div className="home-library-header">
            <div>
              <h2 className="home-section-title">Discografía</h2>
            </div>
          </div>
          <div className="release-row" aria-hidden="true">
            {[1, 2, 3, 4, 5, 6].map((k) => (
              <div key={k} className="release-card release-card--skeleton">
                <div className="release-card-art release-card-art--skeleton" />
                <div className="artist-skeleton-line" style={{ width: '85%', marginTop: '0.55rem' }} />
                <div className="artist-skeleton-line" style={{ width: '50%', marginTop: '0.4rem' }} />
              </div>
            ))}
          </div>
        </section>
      ) : (
        <>
          {featuredRelease && (
            <section className="artist-songs-section">
              {/* Mismo lenguaje que las release cards (arte cuadrado arriba,
                  título debajo) pero a escala mayor — la jerarquía la da el
                  tamaño y la sombra más profunda (material más grueso), no un
                  layout horizontal distinto que chocaba con el resto. */}
              <div className="release-row">
                <div
                  className="release-card featured"
                  onClick={() => handlePlayAlbum(featuredRelease)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      handlePlayAlbum(featuredRelease)
                    }
                  }}
                >
                  <p className="home-section-kicker">Último lanzamiento</p>
                  <div className="release-card-art">
                    <CachedImg src={featuredRelease.thumbUrl} alt="" title={featuredRelease.title} />
                  </div>
                  <p className="release-card-title">{featuredRelease.title}</p>
                  <p className="release-card-sub">
                    {[featuredRelease.type, featuredRelease.year].filter(Boolean).join(' · ')}
                  </p>
                </div>
              </div>
            </section>
          )}

          {/* Catalog Sections */}
          <ReleaseGrid title="Álbumes" releases={studioAlbums} onPlay={handlePlayAlbum} />
          <ReleaseGrid title="Sencillos y EPs" releases={singlesAndEps} onPlay={handlePlayAlbum} />
          <ReleaseGrid title="En vivo" releases={liveAlbums} onPlay={handlePlayAlbum} />
          <ReleaseGrid title="Compilaciones" releases={compilations} onPlay={handlePlayAlbum} />
        </>
      )}

      {/* Empty state when no albums found */}
      {!albumsLoading && !discographyLoading && unifiedDiscography.length === 0 && (
        <section className="artist-songs-section">
          <div className="home-library-header">
            <div>
              <h2 className="home-section-title">Catálogo</h2>
            </div>
          </div>
          <p className="home-empty">No encontramos álbumes para este artista.</p>
        </section>
      )}
    </div>
  )
}