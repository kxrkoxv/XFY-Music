import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// --- Mocks de todas las dependencias externas del store ---
// songIdentity y artistNames son módulos puros ya migrados: se usan reales.
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))
vi.mock('@features/player/lib/downloadQueue', () => ({
  enqueueDownload: vi.fn(() => Promise.resolve('ok')),
  prefetch: vi.fn(),
}))
vi.mock('@features/player/lib/smartCache', () => ({
  prefetchQueueAhead: vi.fn(() => Promise.resolve()),
}))
vi.mock('@features/player/lib/ytblob', () => ({
  getCachedAudioUrl: vi.fn(() => Promise.resolve(null)),
  resolveCachedAudio: vi.fn(() => Promise.resolve(null)),
  requestCache: vi.fn(() => Promise.resolve({ status: 'processing' })),
  watchCacheReady: vi.fn(),
}))
vi.mock('@shared/lib/cacheManager', () => ({
  getCachedAssetIfPresent: vi.fn(() => Promise.resolve(null)),
}))
vi.mock('@shared/lib/metrics', () => ({
  recordListen: vi.fn(),
  recordPlaytime: vi.fn(),
  getSongAffinityScores: vi.fn(() => new Map()),
  FLUSH_INTERVAL_MS: 15000,
}))
vi.mock('@features/player/lib/autoplay', () => ({
  getAutoplayExtension: vi.fn(() => Promise.resolve([])),
}))
vi.mock('@features/catalog/lib/recommendations', () => ({
  getTopArtistRecommendations: vi.fn(() => Promise.resolve([])),
}))
vi.mock('@services/api/ytmusic', () => ({
  getSong: vi.fn(() => Promise.resolve(null)),
}))
vi.mock('@services/api/appleClient', () => ({
  lookupArtistName: vi.fn(() => Promise.resolve(null)),
}))

const { toast } = await import('sonner')
const { enqueueDownload } = await import('@features/player/lib/downloadQueue')
const { resolveCachedAudio, requestCache } = await import('@features/player/lib/ytblob')
const { getCachedAssetIfPresent } = await import('@shared/lib/cacheManager')
const { recordListen } = await import('@shared/lib/metrics')
const { usePlayerStore, isYouTubeSong } = await import('./usePlayerStore')

function song(overrides: Record<string, unknown> = {}) {
  return {
    id: 'abc12345678',
    videoId: 'abc12345678',
    title: 'Andrea',
    artist: 'Bad Bunny',
    artists: [{ name: 'Bad Bunny' }],
    albumArtUrl: null,
    duration: 200,
    source: 'youtube',
    ...overrides,
  }
}

function externalSong(overrides: Record<string, unknown> = {}) {
  return {
    id: 'ext-1',
    title: 'Track externo',
    artist: 'Artista X',
    isExternal: true,
    audioSrc: 'https://cdn.example.com/track.mp3',
    ...overrides,
  }
}

function makeAudioEl() {
  return {
    volume: 1,
    src: '',
    currentTime: 0,
    play: vi.fn(() => Promise.resolve()),
    pause: vi.fn(),
    load: vi.fn(),
    removeAttribute: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }
}

// El store es un singleton a nivel de módulo: se resetea el estado
// relevante entre tests para que no se filtren efectos de uno a otro.
beforeEach(() => {
  localStorage.clear()
  // No se usa el reset() del propio store acá: depende de audioEl/ytController,
  // que en el test anterior pueden haber quedado seteados como mocks parciales
  // (p. ej. sin .stop) — llamarlo arrastraría ese mock incompleto. Se fuerza
  // el estado inicial completo directamente.
  usePlayerStore.setState({
    audioEl: null,
    ytController: null,
    queue: [],
    currentIndex: -1,
    isPlaying: false,
    currentTime: 0,
    duration: 0,
    isShuffle: false,
    repeatMode: 0,
    volume: 0.8,
    isBuffering: false,
    _blobUrl: null,
    _consecutiveErrors: 0,
    _ytFallbackStage: null,
    _autoplayBlockedFor: null,
    autoplayEnabled: true,
    _extendingAutoplay: false,
    _listenedMs: 0,
    _lastTickTime: 0,
    _metricsSong: null,
    _engine: 'audio',
  })
  vi.clearAllMocks()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('isYouTubeSong', () => {
  it('reconoce una canción de YouTube con videoId', () => {
    expect(isYouTubeSong(song())).toBe(true)
  })

  it('rechaza canciones sin source youtube', () => {
    expect(isYouTubeSong(externalSong())).toBe(false)
  })

  it('rechaza null/undefined', () => {
    expect(isYouTubeSong(null)).toBe(false)
    expect(isYouTubeSong(undefined)).toBe(false)
  })
})

describe('play / pause / toggle', () => {
  it('play() en motor audio llama audioEl.play y setea isPlaying', async () => {
    const audioEl = makeAudioEl()
    usePlayerStore.setState({
      audioEl: audioEl as unknown as HTMLAudioElement,
      queue: [song()],
      currentIndex: 0,
      _engine: 'audio',
    })
    await usePlayerStore.getState().play()
    expect(audioEl.play).toHaveBeenCalled()
    expect(usePlayerStore.getState().isPlaying).toBe(true)
  })

  it('play() no hace nada si la cola está vacía', async () => {
    const audioEl = makeAudioEl()
    usePlayerStore.setState({ audioEl: audioEl as unknown as HTMLAudioElement, queue: [], currentIndex: -1 })
    await usePlayerStore.getState().play()
    expect(audioEl.play).not.toHaveBeenCalled()
  })

  it('play() en motor youtube llama ytController.play()', async () => {
    const ytController = { play: vi.fn(), pause: vi.fn(), stop: vi.fn(), setVolume: vi.fn() }
    usePlayerStore.setState({
      ytController: ytController as any,
      queue: [song()],
      currentIndex: 0,
      _engine: 'youtube',
    })
    await usePlayerStore.getState().play()
    expect(ytController.play).toHaveBeenCalled()
    expect(usePlayerStore.getState().isPlaying).toBe(true)
  })

  it('pause() detiene el motor activo y flushea métricas', () => {
    const audioEl = makeAudioEl()
    usePlayerStore.setState({
      audioEl: audioEl as unknown as HTMLAudioElement,
      _engine: 'audio',
      isPlaying: true,
      _listenedMs: 20000,
      _trackListenedMs: 20000,
      _metricsSong: song(),
    })
    usePlayerStore.getState().pause()
    expect(audioEl.pause).toHaveBeenCalled()
    expect(usePlayerStore.getState().isPlaying).toBe(false)
    expect(recordListen).toHaveBeenCalledWith(
      expect.objectContaining({ song: expect.objectContaining({ id: 'abc12345678' }), ms: 20000 }),
    )
  })

  it('toggle() alterna entre play y pause', async () => {
    const audioEl = makeAudioEl()
    usePlayerStore.setState({
      audioEl: audioEl as unknown as HTMLAudioElement,
      queue: [song()],
      currentIndex: 0,
      _engine: 'audio',
      isPlaying: false,
    })
    usePlayerStore.getState().toggle()
    expect(audioEl.play).toHaveBeenCalled()
  })
})

describe('next / previous', () => {
  it('next() avanza secuencialmente y da la vuelta al final', async () => {
    usePlayerStore.setState({ queue: [song({ id: 1 }), song({ id: 2 })], currentIndex: 1, isShuffle: false })
    await usePlayerStore.getState().next()
    expect(usePlayerStore.getState().currentIndex).toBe(0)
  })

  it('next() con shuffle nunca repite el índice actual (cola > 1)', async () => {
    const queue = [song({ id: 1 }), song({ id: 2 }), song({ id: 3 })]
    usePlayerStore.setState({ queue, currentIndex: 0, isShuffle: true })
    for (let i = 0; i < 10; i++) {
      usePlayerStore.setState({ currentIndex: 0 })
      await usePlayerStore.getState().next()
      expect(usePlayerStore.getState().currentIndex).not.toBe(0)
    }
  })

  it('previous() reinicia la pista si pasaron más de 3s', async () => {
    const audioEl = makeAudioEl()
    audioEl.currentTime = 10
    usePlayerStore.setState({
      audioEl: audioEl as unknown as HTMLAudioElement,
      queue: [song({ id: 1 }), song({ id: 2 })],
      currentIndex: 1,
      _engine: 'audio',
    })
    await usePlayerStore.getState().previous()
    expect(audioEl.currentTime).toBe(0)
    expect(usePlayerStore.getState().currentIndex).toBe(1) // no cambió de pista
  })

  it('previous() retrocede de pista si quedan menos de 3s', async () => {
    const audioEl = makeAudioEl()
    audioEl.currentTime = 1
    usePlayerStore.setState({
      audioEl: audioEl as unknown as HTMLAudioElement,
      queue: [song({ id: 1 }), song({ id: 2 })],
      currentIndex: 1,
      _engine: 'audio',
    })
    await usePlayerStore.getState().previous()
    expect(usePlayerStore.getState().currentIndex).toBe(0)
  })
})

describe('handleEnded', () => {
  it('repeatMode=1 reinicia la misma pista', async () => {
    const audioEl = makeAudioEl()
    usePlayerStore.setState({
      audioEl: audioEl as unknown as HTMLAudioElement,
      queue: [song()],
      currentIndex: 0,
      _engine: 'audio',
      repeatMode: 1,
    })
    await usePlayerStore.getState().handleEnded()
    expect(audioEl.currentTime).toBe(0)
    expect(audioEl.play).toHaveBeenCalled()
  })

  it('última pista sin repeat ni autoplay detiene la reproducción', async () => {
    usePlayerStore.setState({
      queue: [song({ id: 1 })],
      currentIndex: 0,
      repeatMode: 0,
      autoplayEnabled: false,
      isPlaying: true,
    })
    await usePlayerStore.getState().handleEnded()
    expect(usePlayerStore.getState().isPlaying).toBe(false)
  })

  it('pista intermedia sin repeat avanza a la siguiente', async () => {
    usePlayerStore.setState({
      queue: [song({ id: 1 }), song({ id: 2 })],
      currentIndex: 0,
      repeatMode: 0,
    })
    await usePlayerStore.getState().handleEnded()
    expect(usePlayerStore.getState().currentIndex).toBe(1)
  })
})

describe('handleTrackError', () => {
  it('avanza a la siguiente pista mientras no se supere el umbral', async () => {
    usePlayerStore.setState({ queue: [song({ id: 1 }), song({ id: 2 })], currentIndex: 0, _consecutiveErrors: 0 })
    await usePlayerStore.getState().handleTrackError()
    expect(usePlayerStore.getState()._consecutiveErrors).toBe(1)
    expect(usePlayerStore.getState().currentIndex).toBe(1)
  })

  it('detiene la reproducción y avisa tras MAX_CONSECUTIVE_ERRORS fallas seguidas', async () => {
    usePlayerStore.setState({ queue: [song({ id: 1 }), song({ id: 2 })], currentIndex: 0, _consecutiveErrors: 3 })
    await usePlayerStore.getState().handleTrackError()
    expect(usePlayerStore.getState()._consecutiveErrors).toBe(0)
    expect(usePlayerStore.getState().isPlaying).toBe(false)
    expect(toast.error).toHaveBeenCalled()
  })

  it('_resetErrorStreak vuelve el contador a cero', () => {
    usePlayerStore.setState({ _consecutiveErrors: 2 })
    usePlayerStore.getState()._resetErrorStreak()
    expect(usePlayerStore.getState()._consecutiveErrors).toBe(0)
  })
})

describe('volumen, seek, shuffle, repeat', () => {
  it('setVolume aplica el volumen al audioEl y al ytController', () => {
    const audioEl = makeAudioEl()
    const ytController = { setVolume: vi.fn() }
    usePlayerStore.setState({ audioEl: audioEl as unknown as HTMLAudioElement, ytController: ytController as any })
    usePlayerStore.getState().setVolume(0.5)
    expect(audioEl.volume).toBe(0.5)
    expect(ytController.setVolume).toHaveBeenCalledWith(0.5)
    expect(usePlayerStore.getState().volume).toBe(0.5)
  })

  it('seek() en motor audio mueve audioEl.currentTime', () => {
    const audioEl = makeAudioEl()
    usePlayerStore.setState({ audioEl: audioEl as unknown as HTMLAudioElement, _engine: 'audio' })
    usePlayerStore.getState().seek(42)
    expect(audioEl.currentTime).toBe(42)
    expect(usePlayerStore.getState().currentTime).toBe(42)
  })

  it('toggleShuffle invierte isShuffle', () => {
    usePlayerStore.setState({ isShuffle: false })
    usePlayerStore.getState().toggleShuffle()
    expect(usePlayerStore.getState().isShuffle).toBe(true)
  })

  it('cycleRepeat rota 0 -> 1 -> 2 -> 0', () => {
    usePlayerStore.setState({ repeatMode: 0 })
    usePlayerStore.getState().cycleRepeat()
    expect(usePlayerStore.getState().repeatMode).toBe(1)
    usePlayerStore.getState().cycleRepeat()
    expect(usePlayerStore.getState().repeatMode).toBe(2)
    usePlayerStore.getState().cycleRepeat()
    expect(usePlayerStore.getState().repeatMode).toBe(0)
  })
})

describe('autoplay preference (localStorage)', () => {
  it('setAutoplayEnabled persiste la preferencia', () => {
    usePlayerStore.getState().setAutoplayEnabled(false)
    expect(localStorage.getItem('xfy_autoplay_enabled')).toBe('false')
    expect(usePlayerStore.getState().autoplayEnabled).toBe(false)
  })
})

describe('recently played', () => {
  it('getRecentlyPlayed devuelve [] si no hay historial guardado', () => {
    expect(usePlayerStore.getState().getRecentlyPlayed()).toEqual([])
  })

  it('playQueueAt agrega la canción actual al historial reciente', async () => {
    const audioEl = makeAudioEl()
    usePlayerStore.setState({ audioEl: audioEl as unknown as HTMLAudioElement, _engine: 'audio' })
    const s = externalSong()
    await usePlayerStore.getState().playQueueAt([s], 0)
    const recent = usePlayerStore.getState().getRecentlyPlayed()
    expect(recent[0]?.id).toBe('ext-1')
  })
})

describe('ruta de audio externo (no YouTube)', () => {
  it('usa el asset cacheado si está presente en vez de re-descargar', async () => {
    vi.mocked(getCachedAssetIfPresent).mockResolvedValueOnce('blob://cached-track')
    const audioEl = makeAudioEl()
    usePlayerStore.setState({ audioEl: audioEl as unknown as HTMLAudioElement, _engine: 'audio' })
    await usePlayerStore.getState().playQueueAt([externalSong()], 0)
    expect(audioEl.src).toBe('blob://cached-track')
    expect(enqueueDownload).not.toHaveBeenCalled()
  })

  it('si no hay caché, streamea la URL remota y encola la descarga en background', async () => {
    vi.mocked(getCachedAssetIfPresent).mockResolvedValueOnce(null)
    const audioEl = makeAudioEl()
    usePlayerStore.setState({ audioEl: audioEl as unknown as HTMLAudioElement, _engine: 'audio' })
    await usePlayerStore.getState().playQueueAt([externalSong()], 0)
    expect(audioEl.src).toBe('https://cdn.example.com/track.mp3')
    expect(enqueueDownload).toHaveBeenCalled()
  })
})

describe('ruta de YouTube', () => {
  it('si ya hay audio resuelto en el CDN del blob, reproduce directo por <audio>', async () => {
    vi.mocked(resolveCachedAudio).mockResolvedValueOnce({ url: 'https://blob.cdn/abc.m4a' } as any)
    const audioEl = makeAudioEl()
    usePlayerStore.setState({ audioEl: audioEl as unknown as HTMLAudioElement })
    await usePlayerStore.getState().playQueueAt([song()], 0)
    expect(audioEl.src).toBe('https://blob.cdn/abc.m4a')
    expect(usePlayerStore.getState()._engine).toBe('audio')
    expect(usePlayerStore.getState()._ytFallbackStage).toBe('blob')
  })

  it('sin blob disponible, arranca por IFrame y dispara requestCache en background', async () => {
    vi.mocked(resolveCachedAudio).mockResolvedValueOnce(null)
    const ytController = { play: vi.fn(), pause: vi.fn(), stop: vi.fn(), setVolume: vi.fn(), load: vi.fn(), getCurrentTime: vi.fn(() => 0) }
    usePlayerStore.setState({ ytController: ytController as any })
    await usePlayerStore.getState().playQueueAt([song()], 0)
    expect(usePlayerStore.getState()._engine).toBe('youtube')
    expect(usePlayerStore.getState()._ytFallbackStage).toBe('iframe')
    expect(requestCache).toHaveBeenCalled()
  })
})

describe('reset', () => {
  it('detiene todo y vuelve al estado inicial', () => {
    const audioEl = makeAudioEl()
    const ytController = { stop: vi.fn(), play: vi.fn(), pause: vi.fn(), setVolume: vi.fn() }
    usePlayerStore.setState({
      audioEl: audioEl as unknown as HTMLAudioElement,
      ytController: ytController as any,
      queue: [song()],
      currentIndex: 0,
      isPlaying: true,
    })
    usePlayerStore.getState().reset()
    expect(audioEl.pause).toHaveBeenCalled()
    expect(ytController.stop).toHaveBeenCalled()
    expect(usePlayerStore.getState().queue).toEqual([])
    expect(usePlayerStore.getState().currentIndex).toBe(-1)
    expect(usePlayerStore.getState().isPlaying).toBe(false)
  })
})
