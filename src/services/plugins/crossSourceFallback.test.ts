import { describe, it, expect, beforeEach, vi } from 'vitest'
import { registerPlugin, setPluginEnabled } from './registry'
import { findAlternateStream } from './crossSourceFallback'
import type { MusicSourcePlugin } from './types'

function makePlugin(overrides: Partial<MusicSourcePlugin> & { id: string }): MusicSourcePlugin {
  return {
    name: overrides.id,
    capabilities: { search: true, artistSearch: false, resolveStream: true },
    search: vi.fn(async () => []),
    resolveStream: vi.fn(async () => null),
    ...overrides,
  }
}

beforeEach(() => {
  sessionStorage.clear()
})

describe('findAlternateStream', () => {
  it('salta la fuente excluida (la que ya falló) y no la consulta', async () => {
    const ytmusicSearch = vi.fn(async () => [])
    registerPlugin(makePlugin({ id: 'ytmusic', search: ytmusicSearch }))
    setPluginEnabled('ytmusic', true)

    await findAlternateStream({ title: 'Andrea', artist: 'Bad Bunny' }, 'ytmusic')
    expect(ytmusicSearch).not.toHaveBeenCalled()
  })

  it('descarta resultados que no matchean por fuzzy (título distinto)', async () => {
    registerPlugin(
      makePlugin({
        id: 'fakeA',
        search: vi.fn(async () => [{ id: '1', title: 'Otra Canción Totalmente Distinta', artist: 'Otro Artista' }]),
        resolveStream: vi.fn(async () => ({ url: 'https://example.com/no-deberia-usarse.mp3' })),
      }),
    )
    setPluginEnabled('fakeA', true)

    const result = await findAlternateStream({ title: 'Andrea', artist: 'Bad Bunny' }, 'ytmusic')
    expect(result).toBeNull()
  })

  it('resuelve stream cuando hay match fuzzy confiable', async () => {
    const resolveStream = vi.fn(async () => ({ url: 'https://example.com/andrea.mp3', mimeType: 'audio/mpeg' }))
    registerPlugin(
      makePlugin({
        id: 'fakeB',
        name: 'Fake Source B',
        search: vi.fn(async () => [{ id: 'xyz', title: 'Andrea (Official Video)', artist: 'Bad Bunny' }]),
        resolveStream,
      }),
    )
    setPluginEnabled('fakeB', true)

    const result = await findAlternateStream({ title: 'Andrea', artist: 'Bad Bunny' }, 'ytmusic')
    expect(result).toEqual({
      url: 'https://example.com/andrea.mp3',
      mimeType: 'audio/mpeg',
      sourceId: 'fakeB',
      sourceName: 'Fake Source B',
    })
    expect(resolveStream).toHaveBeenCalledWith('xyz')
  })

  it('abre el circuito tras fallos repetidos y deja de consultar esa fuente', async () => {
    // Query distinta a la de los tests anteriores: los plugins registrados
    // arriba (fakeA/fakeB) devuelven resultados fijos que NO deberían
    // matchear por fuzzy contra esta canción, así el flujo llega a fakeC.
    const song = { title: 'Cancion De Prueba XYZ', artist: 'Artista Ficticio 000' }
    const search = vi.fn(async () => {
      throw new Error('caído')
    })
    registerPlugin(makePlugin({ id: 'fakeC', search }))
    setPluginEnabled('fakeC', true)

    for (let i = 0; i < 3; i++) {
      await findAlternateStream(song, 'ytmusic')
    }
    expect(search).toHaveBeenCalledTimes(3)

    // Cuarto intento: el circuito ya debería estar abierto (3 fallos seguidos).
    await findAlternateStream(song, 'ytmusic')
    expect(search).toHaveBeenCalledTimes(3) // no subió: se saltó sin llamar
  })
})
