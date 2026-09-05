// ============================================================
// Modal de importación de playlists de Spotify. Dos caminos:
//
//  1. Login real (Authorization Code + PKCE, default): el usuario
//     conecta su cuenta y elige, de SU biblioteca (playlists propias +
//     colaborativas, más sus Me Gusta), qué quiere traer a XFY. Import
//     "en bloque": no hay revisión tema por tema, cada selección se
//     matchea contra YT Music y entra completa (los temas sin match se
//     cuentan pero no bloquean el resto).
//
//  2. Pegar un link (fallback, sin login): igual que antes — resuelve
//     una playlist PÚBLICA vía Client Credentials y sí permite revisar
//     tema por tema antes de importar. Ojo: desde los cambios de Spotify
//     a su Web API, esto puede fallar para playlists que antes andaban
//     — por eso el login real es el camino recomendado ahora.
//
// Cada tema de Spotify tiene que "emparejarse" primero con una canción
// de YT Music por título+artista (matchSpotifyTracks) — Spotify no es
// una fuente reproducible en sí misma dentro de XFY.
// ============================================================
import { useState, useRef, useEffect, useMemo } from 'react'
import { Loader2, X, Heart, Music2, AlertTriangle, ListMusic, LogOut, Link2, ChevronLeft } from 'lucide-react'
import { motion, AnimatePresence } from 'motion/react'
import { toast } from 'sonner'
import { useAuthStore } from '@features/auth'
import { useSpotifyConnectStore } from '@features/playlists/store/useSpotifyConnectStore'
import { fetchSpotifyPlaylistTracks, fetchSpotifyLikedTracks, type SpotifyRawTrack } from '@services/api/spotifyAuth'
import { getSpotifyPlaylist, matchSpotifyTracks, type MatchedSpotifyTrack } from '@services/api/spotify'
import type { Song } from '@/types/models'

export interface SpotifyImportSelection {
  song: Song
  addToFavorites: boolean
}

export interface SpotifyImportResult {
  title: string
  thumbUrl: string | null
  selections: SpotifyImportSelection[]
}

const LIKED_ID = '__liked__'

type Step = 'connect' | 'library' | 'paste' | 'matching' | 'review' | 'importing'

interface ImportSpotifyModalProps {
  onClose: () => void
  /** Camino "pegar link": una playlist con revisión tema por tema. */
  onImport: (result: SpotifyImportResult) => Promise<void> | void
  /** Camino "biblioteca": varias playlists/Me Gusta de una, sin review. */
  onImportBulk: (items: SpotifyImportResult[]) => Promise<void> | void
}

const stepTransition = { duration: 0.16, ease: [0.4, 0, 0.2, 1] as const }

export default function ImportSpotifyModal({ onClose, onImport, onImportBulk }: ImportSpotifyModalProps) {
  const currentUser = useAuthStore((s) => s.currentUser)
  const spConnectStatus = useSpotifyConnectStore((s) => s.status)
  const spAuth = useSpotifyConnectStore((s) => s.auth)
  const library = useSpotifyConnectStore((s) => s.library)
  const libraryStatus = useSpotifyConnectStore((s) => s.libraryStatus)
  const connect = useSpotifyConnectStore((s) => s.connect)
  const disconnect = useSpotifyConnectStore((s) => s.disconnect)
  const loadLibrary = useSpotifyConnectStore((s) => s.loadLibrary)
  const ensureAccessToken = useSpotifyConnectStore((s) => s.ensureAccessToken)

  // Arranca en 'paste' (funciona para cualquiera, sin login) salvo que
  // ya haya una cuenta conectada. El login real queda como camino
  // secundario — Spotify lo limita a un puñado de testers agregados a
  // mano, así que ofrecerlo como default rompe para casi todo el mundo.
  const [step, setStep] = useState<Step>(spConnectStatus === 'connected' ? 'library' : 'paste')
  const [connecting, setConnecting] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [bulkProgress, setBulkProgress] = useState({ itemIndex: 0, itemTotal: 0, itemTitle: '', trackDone: 0, trackTotal: 0 })

  // --- flujo viejo: pegar link (fallback sin login) ---
  const [url, setUrl] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [progress, setProgress] = useState({ done: 0, total: 0 })
  const [playlistTitle, setPlaylistTitle] = useState('')
  const [playlistThumb, setPlaylistThumb] = useState<string | null>(null)
  const [matches, setMatches] = useState<MatchedSpotifyTrack[]>([])
  const [included, setIncluded] = useState<Set<number>>(new Set())
  const [favorited, setFavorited] = useState<Set<number>>(new Set())
  const [importing, setImporting] = useState(false)
  const inputRef = useRef<HTMLInputElement | null>(null)

  // Derivado, no sincronizado por efecto: si arrancamos en 'connect' pero
  // ya hay una conexión activa (ej. se reconectó en otra pestaña), se
  // muestra 'library' directamente sin pasar por un render extra.
  const effectiveStep: Step = step === 'connect' && spConnectStatus === 'connected' ? 'library' : step

  useEffect(() => {
    if (effectiveStep === 'library' && currentUser?.email && libraryStatus === 'idle') {
      void loadLibrary(currentUser.email)
    }
  }, [effectiveStep, currentUser?.email, libraryStatus, loadLibrary])

  useEffect(() => {
    if (effectiveStep === 'paste') inputRef.current?.focus()
  }, [effectiveStep])

  const handleConnect = async () => {
    setConnecting(true)
    try {
      await connect() // navega afuera — no hay vuelta de esta promesa en un login exitoso
    } catch {
      setConnecting(false)
      setError('No se pudo iniciar el login con Spotify.')
    }
  }

  const toggleSelected = (id: string) => {
    setSelected((s) => {
      const next = new Set(s)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const selectedCount = selected.size

  const handleBulkImport = async () => {
    if (!currentUser?.email || !spAuth || selected.size === 0) return
    const token = await ensureAccessToken(currentUser.email)
    if (!token) {
      setError('Se venció la conexión con Spotify — reconectá tu cuenta.')
      setStep('connect')
      return
    }

    const items = Array.from(selected)
    setStep('importing')
    const results: SpotifyImportResult[] = []
    // BUGFIX: antes esto era invisible — de "470 favoritos" importados solo
    // entraban los que matcheaban contra YT Music, y el modal se cerraba sin
    // decir cuántos quedaron afuera ni por qué. Ahora se cuenta el total
    // crudo (lo que Spotify realmente devolvió) contra lo que efectivamente
    // matcheó, para poder mostrar un resumen honesto al terminar.
    let rawTotal = 0
    let matchedTotal = 0

    for (let i = 0; i < items.length; i += 1) {
      const id = items[i]!
      const isLiked = id === LIKED_ID
      const meta = isLiked ? null : library?.playlists.find((p) => p.id === id) || null
      const title = isLiked ? 'Me Gusta de Spotify' : meta?.name || 'Playlist de Spotify'
      setBulkProgress({ itemIndex: i, itemTotal: items.length, itemTitle: title, trackDone: 0, trackTotal: 0 })

      let raw: SpotifyRawTrack[] = []
      try {
        raw = isLiked ? await fetchSpotifyLikedTracks(token) : await fetchSpotifyPlaylistTracks(token, id)
      } catch {
        continue
      }
      if (raw.length === 0) continue
      rawTotal += raw.length

      setBulkProgress((p) => ({ ...p, trackTotal: raw.length }))
      const matched = await matchSpotifyTracks(raw, (done, total) =>
        setBulkProgress((p) => ({ ...p, trackDone: done, trackTotal: total })),
      )
      const selections: SpotifyImportSelection[] = matched
        .filter((m): m is MatchedSpotifyTrack & { song: Song } => m.song != null)
        .map((m) => ({ song: m.song, addToFavorites: isLiked }))
      matchedTotal += selections.length
      if (selections.length > 0) {
        results.push({ title, thumbUrl: isLiked ? null : meta?.thumbUrl || null, selections })
      }
    }

    try {
      await onImportBulk(results)
      onClose()
      if (rawTotal > 0) {
        const missed = rawTotal - matchedTotal
        if (missed > 0) {
          toast.success(`Se importaron ${matchedTotal} de ${rawTotal} canciones`, {
            description: `${missed} no se encontraron en YT Music (título/artista sin coincidencia) — podés reintentar la importación más tarde para esas.`,
          })
        } else {
          toast.success(`Se importaron las ${matchedTotal} canciones`)
        }
      }
    } catch {
      setError('Algo falló importando. Probá de nuevo en un momento.')
      setStep('library')
    }
  }

  // --- flujo viejo: pegar link ---
  const handleResolve = async () => {
    const q = url.trim()
    if (!q) return
    setError(null)
    setStep('matching')
    setProgress({ done: 0, total: 0 })
    try {
      const playlist = await getSpotifyPlaylist(q)
      if (!playlist?.tracks?.length) {
        setError('No se pudo leer esa playlist. Verificá que el link sea público.')
        setStep('paste')
        return
      }
      setPlaylistTitle(playlist.title)
      setPlaylistThumb(playlist.thumbUrl)
      setProgress({ done: 0, total: playlist.tracks.length })

      const matched = await matchSpotifyTracks(playlist.tracks, (done, total) => setProgress({ done, total }))
      setMatches(matched)
      const foundIdx = new Set(matched.map((m, i) => (m.song ? i : -1)).filter((i) => i !== -1))
      setIncluded(foundIdx)
      setFavorited(new Set())
      setStep('review')
    } catch {
      setError('No se pudo importar esa playlist. Probá de nuevo en un momento.')
      setStep('paste')
    }
  }

  const toggleIncluded = (i: number) => {
    setIncluded((s) => {
      const next = new Set(s)
      if (next.has(i)) {
        next.delete(i)
        setFavorited((f) => {
          const nf = new Set(f)
          nf.delete(i)
          return nf
        })
      } else next.add(i)
      return next
    })
  }

  const toggleFavorited = (i: number) => {
    if (!included.has(i)) return
    setFavorited((s) => {
      const next = new Set(s)
      if (next.has(i)) next.delete(i)
      else next.add(i)
      return next
    })
  }

  const markAllFavorites = () => setFavorited(new Set(included))
  const clearAllFavorites = () => setFavorited(new Set())

  const handleConfirmImport = async () => {
    const selections: SpotifyImportSelection[] = matches
      .map((m, i) => (included.has(i) && m.song ? { song: m.song, addToFavorites: favorited.has(i) } : null))
      .filter((s): s is SpotifyImportSelection => s !== null)
    if (selections.length === 0) return
    setImporting(true)
    try {
      await onImport({ title: playlistTitle, thumbUrl: playlistThumb, selections })
      onClose()
    } finally {
      setImporting(false)
    }
  }

  const matchedCount = matches.filter((m) => m.song).length
  const unmatchedCount = matches.length - matchedCount

  const title = useMemo(() => {
    if (effectiveStep === 'library') return 'Tu biblioteca de Spotify'
    if (effectiveStep === 'matching') return 'Leyendo la playlist'
    if (effectiveStep === 'review') return 'Revisar canciones'
    if (effectiveStep === 'importing') return 'Importando'
    return 'Importar de Spotify'
  }, [effectiveStep])

  return (
    <motion.div
      className="import-backdrop"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      onClick={(e) => e.target === e.currentTarget && effectiveStep !== 'importing' && onClose()}
    >
      <motion.div
        className="import-modal"
        initial={{ opacity: 0, scale: 0.96, y: 12 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.96, y: 12 }}
        transition={{ type: 'spring', stiffness: 380, damping: 32 }}
      >
        <div className="import-modal-header">
          <div>
            <p className="import-modal-kicker">Spotify</p>
            <h2 className="import-modal-title">{title}</h2>
          </div>
          {effectiveStep !== 'importing' && (
            <button className="import-modal-close" onClick={onClose}><X size={18} /></button>
          )}
        </div>

        <AnimatePresence mode="wait">
          {effectiveStep === 'connect' && (
            <motion.div key="connect" {...fadeStep}>
              <button className="spotify-connect-alt spotify-back-link" onClick={() => { setError(null); setStep('paste') }}>
                <ChevronLeft size={14} /> Volver
              </button>
              <div className="spotify-connect-panel">
                <div className="spotify-connect-icon"><Music2 size={26} /></div>
                <span className="spotify-connect-badge">Beta · cupo limitado</span>
                <p className="spotify-connect-copy">
                  Spotify solo deja usar el login real con cuentas que agregamos a mano como testers — es una
                  restricción de su plataforma para apps chicas, no algo que podamos habilitar desde acá. Si tu
                  cuenta no está en la lista, el login te va a devolver un error 403.
                </p>
                <p className="spotify-connect-copy spotify-connect-copy--muted">
                  Para importar sin restricciones, pegá el link de la playlist (funciona para cualquiera, sin login).
                </p>
                {error && <p className="import-hint" style={{ color: 'var(--danger, #f66)' }}>{error}</p>}
                <button
                  className="pl-action-btn pl-action-btn--primary spotify-connect-btn"
                  onClick={handleConnect}
                  disabled={connecting}
                >
                  {connecting ? <Loader2 size={14} className="import-spinner" /> : <Music2 size={15} />}
                  {connecting ? 'Abriendo Spotify…' : 'Conectar con Spotify'}
                </button>
              </div>
            </motion.div>
          )}

          {effectiveStep === 'library' && (
            <motion.div key="library" {...fadeStep} style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
              {spAuth && (
                <div className="spotify-account-bar">
                  {spAuth.avatarUrl
                    ? <img src={spAuth.avatarUrl} alt="" className="spotify-account-avatar" />
                    : <div className="spotify-account-avatar spotify-account-avatar--fallback"><Music2 size={14} /></div>}
                  <span className="spotify-account-name">{spAuth.displayName || 'Cuenta de Spotify'}</span>
                  <button
                    className="spotify-account-disconnect"
                    onClick={() => currentUser?.email && disconnect(currentUser.email)}
                    title="Desconectar"
                  >
                    <LogOut size={13} />
                  </button>
                </div>
              )}

              {libraryStatus === 'loading' && (
                <div className="import-preview-loading" style={{ padding: '32px 20px' }}>
                  <Loader2 size={20} className="import-spinner" />
                  <p className="import-hint">Leyendo tu biblioteca de Spotify…</p>
                </div>
              )}

              {libraryStatus === 'error' && (
                <div className="import-preview-loading" style={{ padding: '32px 20px' }}>
                  <AlertTriangle size={20} />
                  <p className="import-hint">No se pudo leer tu biblioteca. Probá de nuevo.</p>
                  <button
                    className="pl-action-btn pl-action-btn--secondary"
                    onClick={() => currentUser?.email && loadLibrary(currentUser.email)}
                  >
                    Reintentar
                  </button>
                </div>
              )}

              {libraryStatus === 'restricted' && (
                <div className="import-preview-loading" style={{ padding: '32px 20px' }}>
                  <AlertTriangle size={20} />
                  <p className="import-hint">
                    Tu cuenta no está habilitada para el login real todavía — Spotify limita esto a un cupo chico de
                    testers. Podés pegar el link de la playlist en su lugar, sin restricciones.
                  </p>
                  <button
                    className="pl-action-btn pl-action-btn--secondary"
                    onClick={() => { setError(null); setStep('paste') }}
                  >
                    <Link2 size={13} /> Pegar un link
                  </button>
                </div>
              )}

              {libraryStatus === 'ready' && library && (
                <>
                  <div className="spotify-lib-list">
                    {library.likedTracksCount > 0 && (
                      <label className="spotify-lib-item">
                        <input
                          type="checkbox"
                          checked={selected.has(LIKED_ID)}
                          onChange={() => toggleSelected(LIKED_ID)}
                        />
                        <div className="spotify-lib-item-art spotify-lib-item-art--liked"><Heart size={16} fill="currentColor" /></div>
                        <div className="spotify-lib-item-info">
                          <p className="spotify-lib-item-name">Me Gusta</p>
                          <p className="spotify-lib-item-sub">{library.likedTracksCount} canciones</p>
                        </div>
                      </label>
                    )}
                    {library.playlists.map((p) => (
                      <label className="spotify-lib-item" key={p.id}>
                        <input type="checkbox" checked={selected.has(p.id)} onChange={() => toggleSelected(p.id)} />
                        <div className="spotify-lib-item-art">
                          {p.thumbUrl
                            ? <img src={p.thumbUrl} alt="" />
                            : <ListMusic size={16} />}
                        </div>
                        <div className="spotify-lib-item-info">
                          <p className="spotify-lib-item-name">{p.name}</p>
                          <p className="spotify-lib-item-sub">
                            {p.trackCount} canciones{!p.ownedByUser ? ' · colaborativa' : ''}
                          </p>
                        </div>
                      </label>
                    ))}
                    {library.playlists.length === 0 && library.likedTracksCount === 0 && (
                      <p className="import-hint" style={{ padding: '0 20px 16px' }}>
                        No encontramos playlists propias ni colaborativas en tu cuenta.
                      </p>
                    )}
                  </div>
                  <div className="import-preview-footer">
                    <button
                      className="pl-action-btn pl-action-btn--primary import-preview-import-btn"
                      onClick={handleBulkImport}
                      disabled={selectedCount === 0}
                    >
                      Importar seleccionadas ({selectedCount})
                    </button>
                  </div>
                </>
              )}
            </motion.div>
          )}

          {effectiveStep === 'importing' && (
            <motion.div key="importing" {...fadeStep} className="import-preview-loading" style={{ padding: '32px 20px' }}>
              <Loader2 size={20} className="import-spinner" />
              <p className="import-hint">
                Importando "{bulkProgress.itemTitle}" ({bulkProgress.itemIndex + 1}/{bulkProgress.itemTotal})
              </p>
              {bulkProgress.trackTotal > 0 && (
                <p className="import-hint">Emparejando canciones… {bulkProgress.trackDone}/{bulkProgress.trackTotal}</p>
              )}
            </motion.div>
          )}

          {effectiveStep === 'paste' && (
            <motion.div key="paste" {...fadeStep}>
              <p className="import-hint" style={{ padding: '0 20px', textAlign: 'left', marginBottom: 0 }}>
                Pegá el link de una playlist pública de Spotify. La vas a poder revisar tema por tema antes de importar.
              </p>
              <div className="import-search-field" style={{ margin: '0.75rem 20px 20px' }}>
                <input
                  ref={inputRef}
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleResolve()}
                  placeholder="Pegá el link de la playlist de Spotify…"
                />
              </div>
              <div style={{ padding: '0 20px 8px' }}>
                {error && <p className="import-hint" style={{ color: 'var(--danger, #f66)' }}>{error}</p>}
                <button
                  className="pl-action-btn pl-action-btn--primary"
                  disabled={!url.trim()}
                  onClick={handleResolve}
                  style={{ width: '100%' }}
                >
                  Continuar
                </button>
              </div>
              <div style={{ padding: '0 20px 20px', textAlign: 'center' }}>
                <button className="spotify-connect-alt" onClick={() => { setError(null); setStep('connect') }}>
                  <Music2 size={13} /> ¿Tenés acceso beta? Conectar tu cuenta
                </button>
              </div>
            </motion.div>
          )}

          {effectiveStep === 'matching' && (
            <motion.div key="matching" {...fadeStep} className="import-preview-loading" style={{ padding: '32px 20px' }}>
              <Loader2 size={20} className="import-spinner" />
              <p className="import-hint">
                {progress.total ? `Emparejando canciones… ${progress.done}/${progress.total}` : 'Leyendo la playlist…'}
              </p>
            </motion.div>
          )}

          {effectiveStep === 'review' && (
            <motion.div key="review" {...fadeStep}>
              <div style={{ padding: '0 20px 8px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                <p className="import-hint">
                  {matchedCount} de {matches.length} canciones encontradas
                  {unmatchedCount > 0 ? ` · ${unmatchedCount} sin match` : ''}
                </p>
                <div style={{ display: 'flex', gap: 10 }}>
                  <button className="import-preview-back" onClick={markAllFavorites} title="Marcar todos como favoritos">
                    <Heart size={14} /> Todos
                  </button>
                  <button className="import-preview-back" onClick={clearAllFavorites} title="Quitar de favoritos">
                    Ninguno
                  </button>
                </div>
              </div>
              <div className="import-preview-songs">
                {matches.map((m, i) => {
                  const isIncluded = included.has(i)
                  const isFav = favorited.has(i)
                  return (
                    <div key={i} className="import-preview-song" style={{ opacity: m.song ? 1 : 0.5 }}>
                      <input
                        type="checkbox"
                        checked={isIncluded}
                        disabled={!m.song}
                        onChange={() => toggleIncluded(i)}
                        aria-label={`Incluir ${m.spotify.title}`}
                      />
                      <div className="import-preview-song-art">
                        {m.spotify.thumbUrl
                          ? <img src={m.spotify.thumbUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: 6 }} />
                          : <Music2 size={16} />}
                      </div>
                      <div className="import-preview-song-info">
                        <p className="import-preview-song-title">{m.spotify.title}</p>
                        <p className="import-preview-song-artist">
                          {m.spotify.artist}
                          {!m.song && (
                            <span style={{ marginLeft: 6 }}>
                              <AlertTriangle size={11} style={{ verticalAlign: '-1px' }} /> sin match en YT Music
                            </span>
                          )}
                        </p>
                      </div>
                      <button
                        type="button"
                        className="import-preview-back"
                        disabled={!isIncluded}
                        onClick={() => toggleFavorited(i)}
                        aria-label={isFav ? 'Quitar de favoritos' : 'Agregar a favoritos'}
                        title={isFav ? 'Se agregará a Favoritos' : 'Agregar a Favoritos'}
                      >
                        <Heart size={15} fill={isFav ? 'currentColor' : 'none'} />
                      </button>
                    </div>
                  )
                })}
              </div>
              <div className="import-preview-footer">
                <button
                  className="pl-action-btn pl-action-btn--primary import-preview-import-btn"
                  onClick={handleConfirmImport}
                  disabled={importing || included.size === 0}
                >
                  {importing ? <Loader2 size={14} className="import-spinner" /> : null}
                  {importing ? 'Importando…' : `Importar (${included.size})`}
                </button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>
    </motion.div>
  )
}

const fadeStep = {
  initial: { opacity: 0, x: 8 },
  animate: { opacity: 1, x: 0 },
  exit: { opacity: 0, x: -8 },
  transition: stepTransition,
}
