import { useState } from 'react'
import { Menu } from '@base-ui/react/menu'
import { ListPlus, Plus } from 'lucide-react'
import { toast } from 'sonner'
import { useAuthStore } from '@features/auth'
import { usePlaylistsStore } from '@features/playlists/store/usePlaylistsStore'
import type { SongLike } from '@shared/lib/songIdentity'
import type { PlaylistSong } from '@shared/lib/db'
import './AddToPlaylistButton.css'

export default function AddToPlaylistButton({
  song,
  className = '',
}: {
  // Los callers pasan shapes distintos (PlayableSong, AudiusTrack, ...).
  song: SongLike
  className?: string
}) {
  const currentUser = useAuthStore((s) => s.currentUser)
  const playlists = usePlaylistsStore((s) => s.playlists)
  const addSong = usePlaylistsStore((s) => s.addSong)
  const createPlaylist = usePlaylistsStore((s) => s.createPlaylist)
  const [creating, setCreating] = useState(false)

  const handleAdd = async (playlistId: string, playlistName: string) => {
    // borde JS->TS: el store guarda el objeto de canción tal cual llega.
    const ok = await addSong(playlistId, song as PlaylistSong)
    if (ok) toast.success(`Añadida a "${playlistName}"`)
    else toast.error(`No se pudo añadir a "${playlistName}".`)
  }

  const handleCreateAndAdd = async () => {
    if (!currentUser || creating) return
    setCreating(true)
    const playlist = await createPlaylist(currentUser.email, `Nueva playlist ${playlists.length + 1}`)
    setCreating(false)
    if (playlist) {
      const added = await addSong(playlist.id, song as PlaylistSong)
      if (added) toast.success(`Creada "${playlist.name}" y añadida la canción`)
      else toast.error(`Se creó "${playlist.name}" pero no se pudo añadir la canción.`)
    } else {
      toast.error('No se pudo crear la playlist.')
    }
  }

  return (
    <Menu.Root>
      <Menu.Trigger
        className={`add-to-playlist-trigger ${className}`}
        aria-label="Añadir a una playlist"
        onClick={(e) => e.stopPropagation()}
      >
        <ListPlus size={16} />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner sideOffset={6} align="end">
          <Menu.Popup className="add-to-playlist-menu">
            {playlists.length === 0 ? (
              <p className="add-to-playlist-empty">Todavía no tienes playlists</p>
            ) : (
              playlists.map((p) => (
                <Menu.Item key={p.id} className="add-to-playlist-item" onClick={() => handleAdd(p.id, p.name)}>
                  {p.name}
                </Menu.Item>
              ))
            )}
            <Menu.Separator className="add-to-playlist-separator" />
            <Menu.Item className="add-to-playlist-item add-to-playlist-item--new" onClick={handleCreateAndAdd}>
              <Plus size={14} />
              Nueva playlist
            </Menu.Item>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  )
}
