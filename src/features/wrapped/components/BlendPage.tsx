import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { motion, useReducedMotion } from 'motion/react'
import { ArrowLeft, Copy, Loader2, Play, Save, Users2 } from 'lucide-react'
import { toast } from 'sonner'
import { smartGoBack } from '@shared/lib/backStack'
import { exportTasteCode, parseTasteCode } from '@shared/lib/metrics'
import { getBlendSongs } from '@features/catalog/lib/recommendations'
import { usePlayerStore } from '@features/player'
import { usePlaylistsStore } from '@features/playlists'
import { useAuthStore } from '@features/auth'
import QuickGrid from '@features/catalog/components/QuickGrid'
import type { SongLike } from '@shared/lib/songIdentity'
import type { PlaylistSong } from '@shared/lib/db'
import './BlendPage.css'

export default function BlendPage() {
  const navigate = useNavigate()
  const reduceMotion = useReducedMotion()
  const { currentUser } = useAuthStore()
  // MEJORA de performance: mismo fix — selector en vez de store completo.
  const playQueueAt = usePlayerStore((s) => s.playQueueAt)
  const { createPlaylist, addSongs } = usePlaylistsStore()

  const [code, setCode] = useState(() => exportTasteCode())
  const [pasted, setPasted] = useState('')
  const [loading, setLoading] = useState(false)
  const [songs, setSongs] = useState<SongLike[]>([])
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(code)
      toast.success('Código copiado')
    } catch {
      toast.error('No se pudo copiar')
    }
  }

  const handleBlend = async () => {
    setError(null)
    const remote = parseTasteCode(pasted)
    if (!remote) {
      setError('Ese código no es válido — pedile a tu amigo/a que te comparta el suyo desde esta misma pantalla.')
      return
    }
    setLoading(true)
    try {
      const result = await getBlendSongs(remote, 30)
      setSongs(result)
      if (result.length === 0) setError('No encontramos canciones en común para mezclar — escuchen un poco más y prueben de nuevo.')
    } catch {
      setError('Algo falló armando el Blend. Probá de nuevo.')
    } finally {
      setLoading(false)
    }
  }

  const handlePlay = (song: SongLike) => {
    const index = songs.findIndex((s) => s.id === song.id)
    void playQueueAt(songs, index === -1 ? 0 : index).catch(() => {})
    navigate('/player')
  }

  const handleSaveAsPlaylist = async () => {
    if (!currentUser?.email || songs.length === 0) return
    setSaving(true)
    try {
      const playlist = await createPlaylist(currentUser.email, 'Blend', 'Mezcla de gustos generada en XFY')
      if (!playlist) throw new Error('no playlist')
      // MEJORA de performance: iba una por una con un await secuencial (ni
      // siquiera paralelo) — para 30 canciones eran 30 round-trips HTTP en
      // fila. Un solo addSongs resuelve el lote entero.
      const playlistSongs: PlaylistSong[] = songs.map((song) => ({ ...song, id: song.id ?? song.videoId ?? '' }))
      const done = await addSongs(playlist.id, playlistSongs)
      if (done === 0) throw new Error('no songs added')
      toast.success('Blend guardado como playlist')
      navigate(`/playlist/${playlist.id}`)
    } catch {
      toast.error('No se pudo guardar el Blend')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="blend-page">
      <motion.header
        className="blend-header"
        initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -10 }}
        animate={{ opacity: 1, y: 0 }}
      >
        <button type="button" className="blend-back" onClick={() => smartGoBack(navigate, '/')}>
          <ArrowLeft size={18} />
        </button>
        <div className="blend-header-title">
          <Users2 size={18} />
          <h1>Blend</h1>
        </div>
      </motion.header>

      <div className="blend-content">
        <section className="blend-section">
          <h2>Tu código</h2>
          <p className="blend-hint">Compartiselo a un amigo o amiga para que arme un Blend con vos.</p>
          <div className="blend-code-row">
            <input readOnly value={code} className="blend-code-input" onFocus={(e) => e.currentTarget.select()} />
            <button type="button" className="blend-icon-btn" onClick={handleCopy} aria-label="Copiar código">
              <Copy size={16} />
            </button>
          </div>
        </section>

        <section className="blend-section">
          <h2>Pegá el código de tu amigo/a</h2>
          <textarea
            className="blend-paste-input"
            placeholder="Pegá acá el código que te compartieron…"
            value={pasted}
            onChange={(e) => setPasted(e.target.value)}
            rows={3}
          />
          {error && <p className="blend-error">{error}</p>}
          <button type="button" className="blend-blend-btn" onClick={handleBlend} disabled={!pasted.trim() || loading}>
            {loading ? <Loader2 size={16} className="blend-spin" /> : <Users2 size={16} />}
            Armar Blend
          </button>
        </section>

        {songs.length > 0 && (
          <section className="blend-section">
            <div className="blend-result-header">
              <h2>Tu mezcla</h2>
              <button type="button" className="blend-save-btn" onClick={handleSaveAsPlaylist} disabled={saving}>
                {saving ? <Loader2 size={14} className="blend-spin" /> : <Save size={14} />}
                Guardar como playlist
              </button>
            </div>
            <QuickGrid songs={songs} onPlay={handlePlay} />
            <button type="button" className="blend-play-all-btn" onClick={() => handlePlay(songs[0]!)}>
              <Play size={14} fill="currentColor" />
              Reproducir todo
            </button>
          </section>
        )}
      </div>
    </div>
  )
}
