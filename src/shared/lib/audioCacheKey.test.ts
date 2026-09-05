import { describe, it, expect } from 'vitest'
import {
  normalizeText,
  getSongKey,
  slugify,
  hashKey,
  candidateAudioPaths,
  indexPathFor,
  metaPathFor,
  metaIndexPathFor,
  asVideoId,
  asSongKey,
  isVideoId,
  parseVideoId,
} from './audioCacheKey'

describe('normalizeText', () => {
  it('lowercase y saca acentos', () => {
    expect(normalizeText('André Rieu')).toBe('andre rieu')
  })

  it('quita paréntesis/corchetes de decoración', () => {
    expect(normalizeText('Andrea (Official Video)')).toBe('andrea')
    expect(normalizeText('Song [Explicit]')).toBe('song')
  })

  it('corta desde feat./ft.', () => {
    expect(normalizeText('La Canción feat. Otro Artista')).toBe('la cancion')
    expect(normalizeText('La Canción ft. X')).toBe('la cancion')
  })

  it('colapsa puntuación a espacios simples', () => {
    expect(normalizeText('  Don’t   Stop—Me! ')).toBe('don t stop me')
  })

  it('null/undefined → string vacío', () => {
    expect(normalizeText(null)).toBe('')
    expect(normalizeText(undefined)).toBe('')
  })
})

describe('getSongKey', () => {
  it('misma canción con metadata distinta produce la MISMA clave', () => {
    const a = getSongKey('Andrea (Official Video)', 'Bad Bunny')
    const b = getSongKey('ANDREA  feat. nobody', 'bad bunny, Otro')
    expect(a).toBe(b)
  })

  it('toma solo el artista principal (antes de la primera coma)', () => {
    expect(getSongKey('X', 'A, B, C')).toBe(getSongKey('X', 'A'))
    expect(getSongKey('X', 'B')).not.toBe(getSongKey('X', 'A'))
  })

  it('devuelve null si falta título o artista', () => {
    expect(getSongKey('', 'A')).toBeNull()
    expect(getSongKey('T', '')).toBeNull()
    expect(getSongKey('(Official Video)', '(algo)')).toBeNull() // todo se normaliza a vacío
  })
})

describe('hashKey / slugify', () => {
  it('hashKey es estable para la misma entrada', () => {
    expect(hashKey('andrea::bad bunny')).toBe(hashKey('andrea::bad bunny'))
  })

  it('hashKey es ASCII-safe y distinto entre claves distintas', () => {
    const h = hashKey('canción::artista')
    expect(h).toMatch(/^[a-z0-9]+$/)
    expect(h).not.toBe(hashKey('otra::clave'))
  })

  it('slugify respeta maxLen y cae en _desconocido si queda vacío', () => {
    expect(slugify('Título Larguísimo De Canción Que Pasa Del Límite', 10)).toHaveLength(10)
    expect(slugify('(Official Video)')).toBe('_desconocido')
  })
})

describe('rutas del blob store', () => {
  it('candidateAudioPaths da m4a preferido y webm fallback', () => {
    expect(candidateAudioPaths(asVideoId('dQw4w9WgXcQ'))).toEqual([
      'yt-audio/dQw4w9WgXcQ.m4a',
      'yt-audio/dQw4w9WgXcQ.webm',
    ])
  })

  it('isVideoId/parseVideoId validan el formato de 11 chars', () => {
    expect(isVideoId('dQw4w9WgXcQ')).toBe(true)
    expect(isVideoId('corto')).toBe(false)
    expect(isVideoId('con espacios!!')).toBe(false)
    expect(parseVideoId('dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ')
    expect(parseVideoId(null)).toBeNull()
  })

  it('indexPathFor es determinística — cliente y server calculan IGUAL', () => {
    const key = asSongKey(getSongKey('Andrea', 'Bad Bunny') ?? '')
    expect(indexPathFor(key)).toBe(indexPathFor(asSongKey(getSongKey('ANDREA', 'bad bunny') ?? '')))
    expect(indexPathFor(key)).toBe(`yt-audio/_index/${slugify(key, 40)}-${hashKey(key)}.json`)
  })

  it('metaPathFor agrupa por artista y metaIndexPathFor indexa por videoId', () => {
    expect(metaPathFor(asVideoId('abc12345678'), 'Bad Bunny')).toBe('yt-audio-meta/bad-bunny/abc12345678.json')
    expect(metaIndexPathFor(asVideoId('abc12345678'))).toBe('yt-audio-meta/_by-video/abc12345678.json')
  })
})
