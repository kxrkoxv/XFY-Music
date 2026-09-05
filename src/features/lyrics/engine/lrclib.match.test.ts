import { describe, it, expect } from 'vitest'
import { scoreCandidate } from './lrclib'

/** Registro LRCLIB de utilidad para los tests. */
function rec(overrides: Partial<Parameters<typeof scoreCandidate>[0]> = {}): Parameters<typeof scoreCandidate>[0] {
  return {
    trackName: 'Dakiti',
    artistName: 'Bad Bunny',
    duration: 200,
    syncedLyrics: '[00:01] x',
    instrumental: false,
    ...overrides,
  }
}

const query = { title: 'Dakiti', artist: 'Bad Bunny', duration: 200 }

describe('scoreCandidate — asignación correcta de letra', () => {
  it('el match exacto de título+artista domina el puntaje', () => {
    const exact = scoreCandidate(rec(), query)
    const otherTitle = scoreCandidate(rec({ trackName: 'Otra' }), query)
    expect(exact).toBeGreaterThanOrEqual(40)
    expect(otherTitle).toBeLessThan(exact - 15)
  })

  it('la guardia dura de duración descarta versiones distintas (>10s)', () => {
    // Mismo título/artista EXACTO pero duración de una versión live/sped-up:
    // antes ganaba igual por el match de texto y se le asignaba la letra
    // equivocada a la canción. Ahora debe quedar descartado.
    const remaster = rec({ duration: 200 + 45 })
    expect(scoreCandidate(remaster, { ...query, duration: 200 })).toBeLessThan(0)

    // En cambio, dentro del margen razonable suma como desempate fino.
    const close = rec({ duration: 202 })
    expect(scoreCandidate(close, { ...query, duration: 200 })).toBeGreaterThan(40)
  })

  it('sin duración conocida no aplica la guardia dura', () => {
    const noDuration = rec({ duration: 999 })
    expect(scoreCandidate(noDuration, { title: 'Dakiti', artist: 'Bad Bunny', duration: null })).toBeGreaterThanOrEqual(40)
  })

  it('ser instrumental penaliza fuerte pero no anula un match perfecto', () => {
    const instrumental = rec({ instrumental: true })
    const s = scoreCandidate(instrumental, query)
    expect(s).toBeGreaterThanOrEqual(10) // sigue siendo la canción correcta
    expect(s).toBeLessThan(scoreCandidate(rec(), query))
  })

  it('un candidato sin nada en común queda bajo el umbral de aceptación', () => {
    expect(scoreCandidate(rec({ trackName: 'Otra cosa', artistName: 'Otro Artista', syncedLyrics: null }), query)).toBeLessThan(10)
  })
})
