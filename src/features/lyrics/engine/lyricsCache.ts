// Caché durable de letras y alineaciones sobre IndexedDB.
//
// Por qué IndexedDB y no localStorage/sessionStorage (que era lo que
// usaban lrclib.js / alignedLyrics.js): 
//   - sessionStorage muere al cerrar la pestaña: volver a una canción
//     al día siguiente volvía a pegarle a LRCLIB (y a pagar la búsqueda
//     de nuevo) aunque la letra no cambia NUNCA para una grabación.
//   - localStorage comparte cupo (~5MB) con todo lo demás y en modo
//     privado lanza al escribir; las letras de una biblioteca entera
//     no entran.
//   - IndexedDB sobrevive recargas, sesiones y (a diferencia del caché
//     HTTP) no lo pisa el usuario al vaciar "caché del navegador".
//
// Shape: un solo object store `entries`, clave string
// (`lrclib:{title}::{artist}` o `align:{trackId}`), valor JSON con
// updatedAt para diagnóstico. Layer en memoria encima para el hot path
// (el mismo patrón que usaban los caches viejos): la primera lectura de
// cada clave igual pasa por IDB una vez por sesión, después es Map.
//
// Migración: si la clave no está en IDB pero sí en la clave vieja de
// localStorage/sessionStorage (prefijos xfy:lrclib: / xfy:aligned-lyrics:),
// se importa tal cual y se borra de storage — ida sola, sin doble escritura.

const DB_NAME = 'xfy-lyrics-cache'
const DB_VERSION = 1
const STORE = 'entries'

export interface LyricCacheEntry<T> {
  value: T
  updatedAt: number
}

let dbPromise: Promise<IDBDatabase | null> | null = null

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') {
        resolve(null)
        return
      }
      const req = indexedDB.open(DB_NAME, DB_VERSION)
      req.onupgradeneeded = () => {
        const db = req.result
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE)
        }
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => resolve(null)
      req.onblocked = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
  return dbPromise
}

/** Capa caliente en memoria — evita re-leer IDB en cada cambio de línea activa. */
const memory = new Map<string, LyricCacheEntry<unknown>>()

async function idbGet<T>(key: string): Promise<LyricCacheEntry<T> | null> {
  const db = await openDb()
  if (!db) return null
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readonly')
      const req = tx.objectStore(STORE).get(key)
      req.onsuccess = () => resolve((req.result as LyricCacheEntry<T> | undefined) ?? null)
      req.onerror = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
}

async function idbSet<T>(key: string, entry: LyricCacheEntry<T>): Promise<void> {
  const db = await openDb()
  if (!db) return
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).put(entry, key)
      tx.oncomplete = () => resolve()
      tx.onerror = () => resolve()
      tx.onabort = () => resolve()
    } catch {
      resolve()
    }
  })
}

/**
 * Lee `key` del caché de letras. Orden: memoria → IndexedDB → legacy
 * (localStorage/sessionStorage, migrando el valor si existe). Devuelve
 * `undefined` cuando no hay nada — distinguible de un `null` guardado
 * a propósito (ej. "LRCLIB no tiene letra para esta canción", que también
 * se cachea para no re-preguntar).
 */
export async function readLyricCache<T>(key: string): Promise<T | undefined> {
  const mem = memory.get(key) as LyricCacheEntry<T> | undefined
  if (mem) return mem.value

  const fromIdb = await idbGet<T>(key)
  if (fromIdb) {
    memory.set(key, fromIdb as LyricCacheEntry<unknown>)
    return fromIdb.value
  }

  // Migración one-shot desde los caches legacy de storage.
  const migrated = readLegacy<T>(key)
  if (migrated !== undefined) {
    await writeLyricCache(key, migrated)
    clearLegacy(key)
    return migrated
  }
  return undefined
}

export async function writeLyricCache<T>(key: string, value: T): Promise<void> {
  const entry: LyricCacheEntry<T> = { value, updatedAt: Date.now() }
  memory.set(key, entry as LyricCacheEntry<unknown>)
  await idbSet(key, entry)
}

/** Claves legacy de lrclib.js / alignedLyrics.js (localStorage/sessionStorage). */
function readLegacy<T>(key: string): T | undefined {
  try {
    let raw: string | null = null
    if (key.startsWith('lrclib:')) raw = sessionStorage.getItem(`xfy:lrclib:${key.slice(7)}`)
    else if (key.startsWith('align:')) raw = localStorage.getItem(`xfy:aligned-lyrics:${key.slice(6)}`)
    if (!raw) return undefined
    return JSON.parse(raw) as T
  } catch {
    return undefined
  }
}

function clearLegacy(key: string): void {
  try {
    if (key.startsWith('lrclib:')) sessionStorage.removeItem(`xfy:lrclib:${key.slice(7)}`)
    else if (key.startsWith('align:')) localStorage.removeItem(`xfy:aligned-lyrics:${key.slice(6)}`)
  } catch {
    /* noop */
  }
}
