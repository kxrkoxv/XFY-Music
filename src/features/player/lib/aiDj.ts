// ============================================================
// AI DJ — versión liviana de la función de Spotify: en vez de un modelo
// de generación de texto + voz sintética propia (lo que usa Spotify, vía
// OpenAI + su voz "Xavier"), esto arma un comentario corto con templates
// sobre datos que YA tenés en metrics.ts (afinidad, sesión, mood) y lo
// lee con la Web Speech API del navegador — sin key, sin backend nuevo.
// ============================================================

import { getMoodContext, getAffinityForSong, getAffinityForArtist, getSessionContext, getTopGenre } from '@shared/lib/metrics'

interface DjSong {
  id?: string | number | null
  title?: string
  artist?: string
}

const MOOD_INTROS: Record<'high' | 'medium' | 'low', string[]> = {
  high: ['Arrancamos con todo.', 'Para agarrar ritmo.', 'Energía para la mañana.'],
  medium: ['Seguimos la tarde así.', 'Para mantener el foco.', 'Buena para el medio del día.'],
  low: ['Para bajar un cambio.', 'Vibras de noche.', 'Algo tranqui para cerrar el día.'],
}

function pick<T>(arr: T[]): T | undefined {
  return arr[Math.floor(Math.random() * arr.length)]
}

/** Arma una línea de comentario en español sobre la canción actual, usando
 *  afinidad/sesión/mood — nunca inventa datos que no existan en metrics.ts. */
export function generateCommentary(song: DjSong): string {
  const mood = getMoodContext()
  const intro = pick(MOOD_INTROS[mood.energy]) || ''
  const title = song.title || 'esta canción'
  const artist = song.artist || ''

  const songAffinity = getAffinityForSong(song.id)
  const artistAffinity = artist ? getAffinityForArtist(artist) : 0
  const session = getSessionContext()
  const sameArtistInSession = artist ? session.filter((e) => e.artist === artist).length : 0
  const topGenre = getTopGenre(1)[0]

  const lines: string[] = [intro]

  if (sameArtistInSession >= 2) {
    lines.push(`Van varias de ${artist} hoy — se nota que estás en esa.`)
  } else if (songAffinity > 3) {
    lines.push(`"${title}" es de tus canciones favoritas últimamente.`)
  } else if (artistAffinity > 50) {
    lines.push(`${artist} viene sonando mucho en tu XFY.`)
  } else if (topGenre) {
    lines.push(`Sigue la vibra de ${topGenre}, que es lo que más escuchás.`)
  } else {
    lines.push(artist ? `Esto es "${title}", de ${artist}.` : `Esto es "${title}".`)
  }

  return lines.filter(Boolean).join(' ')
}

export function isDjNarrationSupported(): boolean {
  return typeof window !== 'undefined' && 'speechSynthesis' in window
}

export function isDjSpeaking(): boolean {
  return isDjNarrationSupported() && window.speechSynthesis.speaking
}

/** Lee el texto en voz alta. Cancela cualquier narración previa en curso
 *  (evita que se pisen dos comentarios si el usuario toca el botón rápido
 *  dos veces seguidas). */
export function speakCommentary(text: string, onEnd?: () => void): void {
  if (!isDjNarrationSupported()) return
  window.speechSynthesis.cancel()

  const utterance = new SpeechSynthesisUtterance(text)
  utterance.lang = 'es-ES'
  utterance.rate = 1.05
  utterance.pitch = 1
  utterance.onend = () => onEnd?.()
  utterance.onerror = () => onEnd?.()
  window.speechSynthesis.speak(utterance)
}

export function stopDjNarration(): void {
  if (isDjNarrationSupported()) window.speechSynthesis.cancel()
}
