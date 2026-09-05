import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { cachedFetch } from './requestCache'

const NS = 'test-ns'

beforeEach(() => {
  localStorage.clear()
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('cachedFetch', () => {
  it('llama al fetcher la primera vez y cachea el resultado', async () => {
    const fetcher = vi.fn().mockResolvedValue({ data: 1 })
    expect(await cachedFetch(NS, 'a', 60_000, fetcher)).toEqual({ data: 1 })
    expect(await cachedFetch(NS, 'a', 60_000, fetcher)).toEqual({ data: 1 }) // desde caché
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('vuelve a golpear la red cuando el TTL expira', async () => {
    const fetcher = vi.fn().mockResolvedValue('v')
    await cachedFetch(NS, 'b', 1000, fetcher)
    vi.advanceTimersByTime(2000)
    await cachedFetch(NS, 'b', 1000, fetcher)
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('deduplica llamadas concurrentes a la MISMA clave (StrictMode)', async () => {
    const fetcher = vi.fn().mockResolvedValue('concurrente')
    const [r1, r2] = await Promise.all([
      cachedFetch(NS, 'c', 60_000, fetcher),
      cachedFetch(NS, 'c', 60_000, fetcher),
    ])
    expect(r1).toBe('concurrente')
    expect(r2).toBe('concurrente')
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('claves distintas no comparten ejecución', async () => {
    const fetcher = vi.fn((k) => Promise.resolve(k))
    await Promise.all([
      cachedFetch(NS, 'd1', 60_000, () => fetcher('d1')),
      cachedFetch(NS, 'd2', 60_000, () => fetcher('d2')),
    ])
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('los ERRORES del fetcher nunca se cachean', async () => {
    const fetcher = vi.fn()
      .mockRejectedValueOnce(new Error('red caída'))
      .mockResolvedValueOnce('recuperado')
    await expect(cachedFetch(NS, 'e', 60_000, fetcher)).rejects.toThrow('red caída')
    expect(await cachedFetch(NS, 'e', 60_000, fetcher)).toBe('recuperado') // reintentó red
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('isCacheable=false evita envenenar el caché con respuestas vacías', async () => {
    const fetcher = vi.fn<() => Promise<unknown>>().mockResolvedValue([])
    await cachedFetch(NS, 'f', 60_000, fetcher, (v) => Array.isArray(v) && v.length > 0)
    expect(await cachedFetch(NS, 'f', 60_000, fetcher, (v) => Array.isArray(v) && v.length > 0)).toEqual([])
    expect(fetcher).toHaveBeenCalledTimes(2) // la vacía no quedó servida de caché
  })

  it('normaliza la clave (case/trim) — "Q" y " q " comparten caché', async () => {
    const fetcher = vi.fn().mockResolvedValue('x')
    await cachedFetch(NS, 'Mi Termino ', 60_000, fetcher)
    await cachedFetch(NS, 'mi termino', 60_000, fetcher)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('sobrevive un localStorage roto/lleno sin romper la llamada', async () => {
    const original = localStorage.setItem
    localStorage.setItem = () => { throw new Error('QuotaExceeded') }
    try {
      const fetcher = vi.fn().mockResolvedValue('igual funciona')
      expect(await cachedFetch(NS, 'g', 60_000, fetcher)).toBe('igual funciona')
    } finally {
      localStorage.setItem = original
    }
  })
})
