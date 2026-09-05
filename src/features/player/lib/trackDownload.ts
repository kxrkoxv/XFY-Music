// Dispara la descarga de /api/download y la guarda vía un <a> temporal —
// mismo patrón que cualquier "descargar archivo" client-side, sin
// dependencias nuevas. Solo tiene sentido para pistas de YouTube (Audius
// ya expone su propia descarga original, ver getOriginalDownloadUrl en
// services/api/audius.ts) — por eso pide videoId, no un id genérico.

import { toast } from 'sonner'
import { primaryArtistName } from '@shared/lib/songIdentity'
import type { PlayerSong } from '@features/player/store/usePlayerStore'

export function canDownloadTrack(song: PlayerSong | null | undefined): boolean {
  return !!song && song.source === 'youtube' && !!(song.videoId || song.id)
}

export async function downloadTrack(song: PlayerSong): Promise<void> {
  const videoId = song.videoId || String(song.id)
  const params = new URLSearchParams({
    videoId,
    download: '1',
    title: song.title || 'Pista desconocida',
    artist: primaryArtistName(song) || song.artist || 'Artista desconocido',
  })
  if (song.album) params.set('album', song.album)
  if (song.albumArtUrl) params.set('cover', song.albumArtUrl)

  const toastId = toast.loading('Preparando descarga…')
  try {
    const res = await fetch(`/api/ytstream?${params.toString()}`)
    if (!res.ok) {
      const body = await res.json().catch(() => null)
      throw new Error(body?.error || `Descarga falló (${res.status})`)
    }
    const blob = await res.blob()
    const disposition = res.headers.get('content-disposition') || ''
    const match = /filename="([^"]+)"/.exec(disposition)
    const filename = match?.[1] || `${song.artist || 'XFY'} - ${song.title || 'pista'}.m4a`

    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 10000)

    toast.success('Descarga lista', { id: toastId })
  } catch (err) {
    toast.error('No se pudo descargar la canción', {
      id: toastId,
      description: err instanceof Error ? err.message : undefined,
    })
  }
}
