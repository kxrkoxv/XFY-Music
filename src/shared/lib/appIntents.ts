// Integraciones de SO con la PWA instalada:
//
//  1. share_target (manifest): el usuario comparte un link de YouTube desde
//     cualquier app → el OS abre "/?url=...&text=..." → acá lo parseamos,
//     resolvemos la canción en YT Music y la mandamos directo a la cola.
//     Con HashRouter la query vive ANTES del hash, así que se puede leer
//     con location.search sin pelear con el router; después se limpia con
//     replaceState para que un refresh no re-dispare nada.
//
//  2. file_handlers (manifest): abrir un .mp3/.m4a/etc "con XFY" → llega
//     por launchQueue (NO por URL) como FileSystemFileHandle. Armamos
//     PlayerSongs con object URLs (isExternal, como las pistas externas)
//     y las reproducimos. Solo funciona instalada y en Chromium.

import { toast } from 'sonner'
import type { PlayerSong } from '@features/player/store/usePlayerStore'
import { usePlayerStore } from '@features/player/store/usePlayerStore'
import { getSong } from '@services/api/ytmusic'

const AUDIO_EXT_RE = /\.(mp3|m4a|aac|ogg|opus|wav|flac)$/i

/** Extrae un videoId de los formatos de link que comparte la app de YouTube. */
export function extractYouTubeId(raw: string): string | null {
  if (!raw) return null
  const patterns = [
    /(?:youtube\.com\/watch\?(?:.*&)?v=)([\w-]{11})/,
    /(?:youtu\.be\/)([\w-]{11})/,
    /(?:youtube\.com\/shorts\/)([\w-]{11})/,
    /(?:youtube\.com\/live\/)([\w-]{11})/,
    /(?:music\.youtube\.com\/watch\?(?:.*&)?v=)([\w-]{11})/,
  ]
  for (const re of patterns) {
    const m = raw.match(re)
    if (m?.[1]) return m[1]
  }
  // ¿El texto compartido ES directamente un videoId pelado?
  if (/^[\w-]{11}$/.test(raw.trim())) return raw.trim()
  return null
}

/**
 * Consume ?url=/?text=/?title= si vienen de un share del OS. Resuelve la
 * canción y la reproduce; si no es un link de YouTube conocido, avisa.
 * Idempotente por diseño: replaceState borra la query al procesarla.
 */
export async function consumeSharedTarget(): Promise<void> {
  if (typeof window === 'undefined') return
  let params: URLSearchParams
  try {
    params = new URLSearchParams(window.location.search)
  } catch {
    return
  }
  const sharedUrl = params.get('url') || ''
  const sharedText = params.get('text') || ''
  const sharedTitle = params.get('title') || ''
  if (!sharedUrl && !sharedText && !sharedTitle) return

  // Limpio YA (antes de await): evita re-procesar si algo de abajo tarda.
  try {
    window.history.replaceState(null, '', window.location.pathname)
  } catch {
    /* noop */
  }

  const candidate = sharedUrl || sharedText || sharedTitle
  const videoId = extractYouTubeId(candidate)
  if (!videoId) {
    toast('No se reconoció el enlace compartido', {
      description: 'XFY entiende links de YouTube / YT Music.',
    })
    return
  }

  try {
    const song = await getSong(videoId)
    if (!song) {
      toast('No pudimos resolver esa canción')
      return
    }
    await usePlayerStore.getState().playQueueAt([song as PlayerSong], 0)
    toast(`Reproduciendo “${song.title}”`, { description: 'Desde lo que compartiste' })
  } catch {
    toast('No se pudo abrir lo compartido', { description: 'Probá buscarlo manualmente.' })
  }
}

interface LaunchParamsLike {
  files?: FileSystemFileHandle[]
}
interface LaunchQueueLike {
  setConsumer(consumer: (params: LaunchParamsLike) => void | Promise<void>): void
}

/**
 * Registra el consumidor de launchQueue para file_handlers. Debe correr
 * UNA vez, temprano (los handles solo se entregan al primer setConsumer).
 */
export function initFileHandlers(): void {
  if (typeof window === 'undefined') return
  const queue = (window as Window & { launchQueue?: LaunchQueueLike }).launchQueue
  if (!queue) return

  queue.setConsumer(async (params) => {
    if (!params.files || params.files.length === 0) return
    try {
      const files: File[] = []
      for (const handle of params.files.slice(0, 50)) {
        const file = await handle.getFile()
        if (AUDIO_EXT_RE.test(file.name) || file.type.startsWith('audio/')) files.push(file)
      }
      if (files.length === 0) {
        toast('XFY reproduce archivos de audio', { description: 'Ese archivo no es de audio.' })
        return
      }

      const songs: PlayerSong[] = files.map((file) => ({
        id: `local:${file.name}:${file.size}`,
        title: file.name.replace(AUDIO_EXT_RE, ''),
        artist: '',
        source: null,
        audioSrc: URL.createObjectURL(file),
        isExternal: true,
      }))
      await usePlayerStore.getState().playQueueAt(songs, 0)
      if (window.location.hash !== '#/player') window.location.hash = '#/player'
      toast(files.length === 1 ? `Reproduciendo “${songs[0]!.title}”` : `${files.length} archivos en cola`)
    } catch {
      toast('No se pudieron abrir los archivos')
    }
  })
}
