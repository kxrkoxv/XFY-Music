// ============================================================
// localSnapshot — caché local "stale-while-revalidate" para los datos
// propios del usuario (perfil, preferencias/favoritos, playlists).
//
// El problema que resuelve: appDB.* SIEMPRE pega a la red (ver db.ts).
// Eso significa que cada vez que se abre la app, useAuthStore y
// usePlaylistsStore quedan en status:'loading' hasta que el server
// responde — pantalla en blanco/skeleton en cada cold start, incluso
// si sos el mismo usuario que ya la abrió hace 10 segundos. Spotify y
// Apple Music no hacen esto: pintan tu librería cacheada al instante y
// reconcilian con el servidor en segundo plano, así que la app "abre"
// aunque haya latencia o estés momentáneamente sin red.
//
// Este módulo no reemplaza a appDB (que sigue siendo la fuente de
// verdad) — solo guarda la ÚLTIMA respuesta buena en localStorage para
// pintar algo real de inmediato, mientras la red confirma o corrige.
//
// Alcance deliberado: solo texto/JSON, ya se guardan solos en
// localStorage. El caché de audio/imágenes (mucho más pesado) ya vive
// en cacheManager.ts con su propio LRU — no se toca acá.
// ============================================================

const NS = 'xfy_snapshot_v1'
const SCHEMA_VERSION = 1

interface Snapshot<T> {
  v: number
  savedAt: number
  data: T
}

function keyFor(kind: string, ownerEmail: string): string {
  return `${NS}:${kind}:${ownerEmail.toLowerCase()}`
}

function read<T>(kind: string, ownerEmail: string | null | undefined): T | null {
  if (!ownerEmail) return null
  try {
    const raw = localStorage.getItem(keyFor(kind, ownerEmail))
    if (!raw) return null
    const parsed = JSON.parse(raw) as Snapshot<T>
    if (parsed.v !== SCHEMA_VERSION) return null
    return parsed.data
  } catch {
    return null
  }
}

function write<T>(kind: string, ownerEmail: string | null | undefined, data: T): void {
  if (!ownerEmail) return
  try {
    const entry: Snapshot<T> = { v: SCHEMA_VERSION, savedAt: Date.now(), data }
    localStorage.setItem(keyFor(kind, ownerEmail), JSON.stringify(entry))
  } catch {
    // localStorage lleno/no disponible (modo privado, cupo excedido) —
    // no es crítico, simplemente no hay snapshot para el próximo cold
    // start y todo sigue andando solo con la red.
  }
}

function clear(kind: string, ownerEmail: string | null | undefined): void {
  if (!ownerEmail) return
  try {
    localStorage.removeItem(keyFor(kind, ownerEmail))
  } catch {
    // ver comentario de write()
  }
}

// --- API tipada por tipo de dato ---

import type { User, Playlist } from '@shared/lib/db'

export const userSnapshot = {
  read: (email: string | null | undefined) => read<User>('user', email),
  write: (email: string | null | undefined, user: User) => write('user', email, user),
  clear: (email: string | null | undefined) => clear('user', email),
}

export const playlistsSnapshot = {
  read: (email: string | null | undefined) => read<Playlist[]>('playlists', email),
  write: (email: string | null | undefined, playlists: Playlist[]) => write('playlists', email, playlists),
  clear: (email: string | null | undefined) => clear('playlists', email),
}

// Se llama en logout: borra todo rastro local del usuario que se va,
// para que el próximo login (u otro usuario en el mismo dispositivo)
// nunca vea por un instante datos que no son suyos.
export function clearAllSnapshots(email: string | null | undefined): void {
  userSnapshot.clear(email)
  playlistsSnapshot.clear(email)
}
