// Adapter fino sobre services/api/audius.ts. AudiusTrack ya viene
// aplanado al shape interno de XFY (title/artist/albumArtUrl/audioSrc),
// así que el mapeo a Song es casi directo.

import { searchTracks, getStreamUrl } from '@services/api/audius'
import type { MusicSourcePlugin } from '../types'
import type { Song } from '@/types/models'

export const audiusSource: MusicSourcePlugin = {
  id: 'audius',
  name: 'Audius',
  capabilities: { search: true, artistSearch: false, resolveStream: true },
  search: async (query, limit) => {
    const tracks = await searchTracks(query, limit)
    return tracks.map(
      (t): Song => ({
        id: `audius:${t.id}`,
        title: t.title,
        artist: t.artist,
        albumArtUrl: t.albumArtUrl,
        source: 'audius',
        duration: t.durationSec,
      }),
    )
  },
  resolveStream: async (audiusId) => ({ url: getStreamUrl(audiusId) }),
}
