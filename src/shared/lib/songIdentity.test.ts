import { describe, it, expect } from 'vitest'
import { normalizeTitle, primaryArtistName, getSongKey, pickBestSong, dedupeSongs, isSameSong, type SongLike } from './songIdentity'

const base: SongLike = { id: 'v1', title: 'Andrea', artist: 'Bad Bunny' }

describe('normalizeTitle / primaryArtistName', () => {
  it('normaliza decoraciones de YT Music', () => {
    expect(normalizeTitle('Andrea (Official Video)')).toBe('andrea')
  })

  it('primaryArtistName prefiere el array artists', () => {
    const song = { artists: [{ name: 'Bad Bunny' }, { name: 'Otro' }], artist: 'Ignorado' }
    expect(primaryArtistName(song)).toBe('Bad Bunny')
  })

  it('primaryArtistName cae al string artist (primera coma)', () => {
    expect(primaryArtistName({ artist: 'A, B' })).toBe('A')
    expect(primaryArtistName({})).toBe('')
  })
})

describe('dedupeSongs', () => {
  it('colapsa copias del mismo videoId-distinto de la misma canción', () => {
    const a: SongLike = { ...base, albumArtUrl: 'portada-buena.jpg' }
    const b: SongLike = { id: 'v2', title: 'ANDREA (Video Oficial)', artist: 'bad bunny' }
    const out = dedupeSongs([a, b])
    expect(out).toHaveLength(1)
    expect(out[0]?.albumArtUrl).toBe('portada-buena.jpg') // quedó la más completa
  })

  it('preserva el orden de primera aparición', () => {
    const c = { id: 'v3', title: 'Otra', artist: 'Alguien' }
    expect(dedupeSongs([{ ...base }, c, { ...base, id: 'v9' }]).map((s) => s.id)).toEqual(['v1', 'v3'])
  })

  it('elige la copia con metadata más completa, no la primera', () => {
    const pobre = { ...base }
    const rica = { id: 'v2', title: 'Andrea', artist: 'Bad Bunny', albumArtUrl: 'x.jpg', album: 'Un Verano Sin Ti', duration: 300, artistId: 'a1' }
    expect(dedupeSongs([pobre, rica])[0]).toBe(rica)
  })

  it('descarta entradas sin id y tolera null/undefined', () => {
    expect(dedupeSongs([null, { title: 'X', artist: 'Y' }, base])).toHaveLength(1)
  })
})

describe('isSameSong / getSongKey / pickBestSong', () => {
  it('mismo id exacto → true aunque cambie todo lo demás', () => {
    expect(isSameSong(base, { id: 'v1', title: 'Otra Cosa', artist: 'Nadie' })).toBe(true)
  })

  it('ids distintos pero misma identidad canónica → true', () => {
    expect(isSameSong(base, { id: 'v2', title: 'ANDREA', artist: 'BAD BUNNY' })).toBe(true)
  })

  it('canciones distintas → false; nulls → false', () => {
    expect(isSameSong(base, { id: 'v2', title: 'Otra', artist: 'Bad Bunny' })).toBe(false)
    expect(isSameSong(null, base)).toBe(false)
  })

  it('getSongKey incluye artista principal normalizado', () => {
    expect(getSongKey({ title: 'Andrea', artist: 'Bad Bunny, Otro' })).toBe(getSongKey({ title: 'andrea', artists: [{ name: 'Bad Bunny' }] }))
  })

  it('pickBestSong devuelve la de mayor completitud (empate → la primera)', () => {
    const a = { ...base, albumArtUrl: 'a.jpg' }
    const b = { ...base, albumArtUrl: 'b.jpg' }
    expect(pickBestSong(a, b)).toBe(a)
  })
})
