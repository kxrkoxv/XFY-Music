// ============================================================
// blurhashCache — cachea el hash borroso (string ~20-30 chars) de cada
// portada ya vista, para poder pintar un placeholder que se PARECE a la
// imagen real (en vez del degradado genérico) mientras esta carga.
//
// Vive en su propia IndexedDB, separada de AppDatabase (db.ts): es un
// dato puramente derivado/desechable (se puede recalcular en cualquier
// momento a partir de la imagen), así que no necesita compartir versión
// de esquema ni migraciones con los datos de usuario.
// ============================================================

import { encode, decode } from 'blurhash'

const DB_NAME = 'XfyBlurhashCache'
const DB_VERSION = 1
const STORE = 'hashes'
const MAX_ENTRIES = 600 // LRU aproximado por orden de inserción; suficiente para varias sesiones de scroll

let dbPromise: Promise<IDBDatabase | null> | null = null

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') {
      resolve(null)
      return
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => resolve(null)
  })
  return dbPromise
}

/** Devuelve el blurhash guardado para `src`, o null si nunca se calculó. */
export async function getBlurhash(src: string): Promise<string | null> {
  const db = await openDb()
  if (!db) return null
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readonly')
      const req = tx.objectStore(STORE).get(src)
      req.onsuccess = () => resolve((req.result as string | undefined) ?? null)
      req.onerror = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
}

async function pruneIfNeeded(db: IDBDatabase): Promise<void> {
  try {
    const tx = db.transaction(STORE, 'readwrite')
    const store = tx.objectStore(STORE)
    const countReq = store.count()
    countReq.onsuccess = () => {
      if (countReq.result <= MAX_ENTRIES) return
      // Sin timestamps por simplicidad: se borran las primeras N claves
      // (orden de inserción en IndexedDB), efecto similar a FIFO.
      const toRemove = countReq.result - MAX_ENTRIES
      const cursorReq = store.openCursor()
      let removed = 0
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result
        if (!cursor || removed >= toRemove) return
        cursor.delete()
        removed++
        cursor.continue()
      }
    }
  } catch {
    /* noop — no es crítico si falla la poda */
  }
}

async function setBlurhash(src: string, hash: string): Promise<void> {
  const db = await openDb()
  if (!db) return
  try {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).put(hash, src)
    await pruneIfNeeded(db)
  } catch {
    /* noop */
  }
}

/**
 * Calcula (si hace falta) y persiste el blurhash de una <img> ya cargada.
 * Se debe llamar en el onLoad de la imagen real; es barato (downscale a
 * ~32x32 antes de codificar) pero de todas formas solo corre una vez por
 * URL gracias al cache.
 */
export async function ensureBlurhash(src: string, img: HTMLImageElement): Promise<void> {
  if (await getBlurhash(src)) return
  try {
    const canvas = document.createElement('canvas')
    const w = 32
    const h = Math.max(1, Math.round((img.naturalHeight / (img.naturalWidth || 1)) * w)) || 32
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.drawImage(img, 0, 0, w, h)
    const { data } = ctx.getImageData(0, 0, w, h)
    const hash = encode(data, w, h, 4, 3)
    await setBlurhash(src, hash)
  } catch {
    // getImageData puede tirar SecurityError si la imagen no habilitó CORS
    // (muchas portadas externas no lo hacen) — se ignora, el fallback
    // genérico de color sigue funcionando igual.
  }
}

/** Decodifica un blurhash a un data URL PNG pequeño, listo para usar como `background-image`. */
export function blurhashToDataUrl(hash: string, w = 32, h = 32): string | null {
  try {
    const pixels = decode(hash, w, h)
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    const imageData = ctx.createImageData(w, h)
    imageData.data.set(pixels)
    ctx.putImageData(imageData, 0, 0)
    return canvas.toDataURL('image/png')
  } catch {
    return null
  }
}
