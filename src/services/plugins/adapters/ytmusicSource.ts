// Adapter fino: envuelve los exports existentes de services/api/ytmusic
// en la interfaz MusicSourcePlugin. No duplica lógica — es el mismo
// cliente de siempre, solo expuesto detrás del contrato común.

import { searchSongs, searchArtists } from '@services/api/ytmusic'
import type { MusicSourcePlugin } from '../types'

export const ytmusicSource: MusicSourcePlugin = {
  id: 'ytmusic',
  name: 'YT Music',
  capabilities: { search: true, artistSearch: true, resolveStream: true },
  search: (query, limit) => searchSongs(query, limit),
  searchArtists: (query, limit) => searchArtists(query, limit),
  resolveStream: async (videoId) => {
    // La resolución real (Innertube + BotGuard + fallback Piped) vive en
    // api/ytcache + api/ytstream — este adapter solo apunta al endpoint,
    // igual que hace el player hoy.
    return { url: `/api/ytstream?videoId=${encodeURIComponent(videoId)}` }
  },
}
