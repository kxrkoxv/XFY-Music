// ============================================================
// Lector de la vieja IndexedDB ("AppDatabase") — apunta al MISMO nombre y
// versión que usaba db.ts antes de la migración a Postgres, para poder
// abrir y leer los datos que haya en el navegador sin tocarlos.
//
// Solo lectura. Se usa una única vez por cuenta desde
// features/auth/lib/migrateLegacyData.ts — después de migrar con éxito no
// hace falta este archivo para nada más, pero se deja por si alguien loguea
// la cuenta vieja en un navegador que todavía no migró.
// ============================================================

const DB_NAME = 'AppDatabase'
const DB_VERSION = 6
const USERS_STORE = 'users'
const PLAYLISTS_STORE = 'playlists'
const THEMES_STORE = 'customThemes'

export interface LegacyUser {
  email: string
  preferences?: {
    favorites?: Record<string, unknown>[]
    [key: string]: unknown
  }
}
export interface LegacyPlaylist {
  userEmail: string
  name: string
  description: string
  songs: Record<string, unknown>[]
  coverUrl: string | null
}
export interface LegacyTheme {
  id: string
  userEmail: string
  name: string
  colors: Record<string, string>
}

function openLegacyDatabase(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    if (!window.indexedDB) return resolve(null)
    const request = window.indexedDB.open(DB_NAME, DB_VERSION)
    request.onerror = () => resolve(null)
    request.onsuccess = () => resolve(request.result)
    // Si la DB no existía, esto la crearía vacía — no pasa nada, no hay
    // nada que migrar y el resto de la app ya no la usa para escribir.
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(USERS_STORE)) {
        const s = db.createObjectStore(USERS_STORE, { keyPath: 'id', autoIncrement: true })
        s.createIndex('email', 'email', { unique: true })
      }
      if (!db.objectStoreNames.contains(PLAYLISTS_STORE)) {
        db.createObjectStore(PLAYLISTS_STORE, { keyPath: 'id' }).createIndex('userEmail', 'userEmail', { unique: false })
      }
      if (!db.objectStoreNames.contains(THEMES_STORE)) {
        db.createObjectStore(THEMES_STORE, { keyPath: 'id' }).createIndex('userEmail', 'userEmail', { unique: false })
      }
    }
  })
}

async function getByIndex<T>(storeName: string, indexName: string, key: string): Promise<T[]> {
  const db = await openLegacyDatabase()
  if (!db) return []
  try {
    const tx = db.transaction([storeName], 'readonly')
    const index = tx.objectStore(storeName).index(indexName)
    const request = index.getAll(key)
    return await new Promise((resolve) => {
      request.onsuccess = () => resolve((request.result as T[]) || [])
      request.onerror = () => resolve([])
    })
  } catch {
    return []
  }
}

export async function readLegacyUser(email: string): Promise<LegacyUser | null> {
  const db = await openLegacyDatabase()
  if (!db) return null
  try {
    const tx = db.transaction([USERS_STORE], 'readonly')
    const index = tx.objectStore(USERS_STORE).index('email')
    const request = index.get(email.toLowerCase().trim())
    return await new Promise((resolve) => {
      request.onsuccess = () => resolve((request.result as LegacyUser) || null)
      request.onerror = () => resolve(null)
    })
  } catch {
    return null
  }
}

export async function readLegacyPlaylists(email: string): Promise<LegacyPlaylist[]> {
  return getByIndex<LegacyPlaylist>(PLAYLISTS_STORE, 'userEmail', email.toLowerCase().trim())
}

export async function readLegacyThemes(email: string): Promise<LegacyTheme[]> {
  return getByIndex<LegacyTheme>(THEMES_STORE, 'userEmail', email.toLowerCase().trim())
}

/** true si hay ALGO para migrar de esta cuenta en la IndexedDB local. */
export async function hasLegacyData(email: string): Promise<boolean> {
  const [user, playlists, themes] = await Promise.all([
    readLegacyUser(email),
    readLegacyPlaylists(email),
    readLegacyThemes(email),
  ])
  const hasFavorites = (user?.preferences?.favorites?.length || 0) > 0
  return hasFavorites || playlists.length > 0 || themes.length > 0
}
