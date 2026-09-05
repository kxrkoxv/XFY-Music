import { describe, it, expect } from 'vitest'
import { estimateWordTimings } from './wordTiming'

describe('estimateWordTimings', () => {
  it('reparte la duración de la línea entre sus palabras', () => {
    const words = estimateWordTimings('hola mundo', 10, 12)
    expect(words).toHaveLength(2)
    expect(words[0]?.start).toBeCloseTo(10)
    // La última palabra termina exactamente en singEnd
    expect(words[words.length - 1]?.end).toBeCloseTo(12)
    // Sin gaps: cada palabra arranca donde termina la anterior
    expect(words[1]?.start).toBeCloseTo(words[0]?.end ?? 0)
  })

  it('palabras más largas reciben más duración', () => {
    const words = estimateWordTimings('y extraordinariamente', 0, 10)
    const corta = words[0]
    const larga = words[1]
    expect(corta && larga).toBeDefined()
    expect((larga?.end ?? 0) - (larga?.start ?? 0)).toBeGreaterThan(
      (corta?.end ?? 0) - (corta?.start ?? 0),
    )
  })

  it('las palabras de una letra no quedan en duración cero (peso mínimo)', () => {
    const words = estimateWordTimings('y a el', 0, 6)
    for (const w of words) {
      expect(w.end - w.start).toBeGreaterThan(0)
    }
  })

  it('texto vacío o solo espacios → []', () => {
    expect(estimateWordTimings('', 0, 5)).toEqual([])
    expect(estimateWordTimings('   ', 0, 5)).toEqual([])
  })

  it('singEnd menor o igual a start cae al piso de duración (0.15s)', () => {
    const words = estimateWordTimings('palabra', 5, 3)
    expect(words).toHaveLength(1)
    expect(words[0]?.start).toBeCloseTo(5)
    expect(words[0]?.end).toBeCloseTo(5.15)
  })

  it('conserva el texto original de cada palabra', () => {
    const words = estimateWordTimings('Hola, mundo!', 0, 4)
    expect(words.map((w) => w.text)).toEqual(['Hola,', 'mundo!'])
  })
})
