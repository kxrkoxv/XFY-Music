import { describe, it, expect, beforeEach } from 'vitest'
import { readLyricCache, writeLyricCache } from './lyricsCache'

/**
 * Nota de entorno: jsdom no trae IndexedDB, así que estos ejercicios
 * cubren exactamente el camino de fallback que interesa verificar —
 * memoria + migración one-shot desde las claves legacy de
 * localStorage/sessionStorage (las que usaban lrclib.js/alignedLyrics.js).
 */

describe('lyricsCache — caché durable con migración legacy', () => {
  beforeEach(() => {
    localStorage.clear()
    sessionStorage.clear()
  })

  it('roundtrip en memoria cuando no hay IndexedDB', async () => {
    await writeLyricCache('lrclib:test::key', { lines: [1, 2], synced: true })
    await expect(readLyricCache('lrclib:test::key')).resolves.toEqual({ lines: [1, 2], synced: true })
  })

  it('migra una clave legacy de sessionStorage (lrclib viejo) sin perder el valor', async () => {
    const value = { lines: [{ time: 1, text: 'hola' }], synced: true }
    sessionStorage.setItem('xfy:lrclib:migrada::uno', JSON.stringify(value))

    await expect(readLyricCache('lrclib:migrada::uno')).resolves.toEqual(value)

    // La clave legacy se limpia al migrar (ida sola, sin doble escritura).
    expect(sessionStorage.getItem('xfy:lrclib:migrada::uno')).toBeNull()
  })

  it('migra una clave legacy de localStorage (alineaciones viejas)', async () => {
    const aligned = [{ time: 3.2, text: 'go', words: [] }]
    localStorage.setItem('xfy:aligned-lyrics:abc123', JSON.stringify(aligned))

    await expect(readLyricCache('align:abc123')).resolves.toEqual(aligned)
    expect(localStorage.getItem('xfy:aligned-lyrics:abc123')).toBeNull()
  })

  it('undefined ≠ null cacheado: "no hay letra" se recuerda tal cual', async () => {
    await writeLyricCache('lrclib:sin-letra', null)
    await expect(readLyricCache('lrclib:sin-letra')).resolves.toBeNull()
    await expect(readLyricCache('lrclib:nunca-pedida')).resolves.toBeUndefined()
  })

  it('storage corrupto no rompe la lectura', async () => {
    localStorage.setItem('xfy:lrclib:roto', '{json-mal')
    await expect(readLyricCache('lrclib:roto')).resolves.toBeUndefined()
  })
})
