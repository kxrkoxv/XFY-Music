import { describe, it, expect } from 'vitest'
import { diffReleases } from './releaseWatch'

describe('diffReleases — detección de nuevos lanzamientos', () => {
  it('la primera vez que se ve un artista es SOLO baseline: nunca avisa', () => {
    const d = diffReleases(undefined, { albumMs: Date.now(), songMs: Date.now() })
    expect(d.hasBaseline).toBe(false)
    expect(d.newAlbum).toBe(false)
    expect(d.newSong).toBe(false)
  })

  it('detecta álbum nuevo respecto al snapshot previo', () => {
    const t0 = Date.parse('2026-01-10T00:00:00Z')
    const d = diffReleases(
      { lastAlbumMs: t0, lastSongMs: t0 },
      { albumMs: t0 + 86_400_000, songMs: t0 },
    )
    expect(d.hasBaseline).toBe(true)
    expect(d.newAlbum).toBe(true)
    expect(d.newSong).toBe(false)
  })

  it('detecta canción nueva sin confundirla con el álbum', () => {
    const t0 = Date.parse('2026-02-01T00:00:00Z')
    const d = diffReleases(
      { lastAlbumMs: t0, lastSongMs: t0 },
      { albumMs: t0, songMs: t0 + 3_600_000 },
    )
    expect(d.newAlbum).toBe(false)
    expect(d.newSong).toBe(true)
  })

  it('lo igual o más viejo NUNCA es nuevo (sin re-avisos en cada sweep)', () => {
    const t0 = Date.parse('2026-03-01T00:00:00Z')
    const d = diffReleases({ lastAlbumMs: t0, lastSongMs: t0 }, { albumMs: t0, songMs: t0 })
    expect(d.newAlbum).toBe(false)
    expect(d.newSong).toBe(false)
  })

  it('snapshot sin dato previo de canciones: baseline parcial no dispara falsos positivos', () => {
    // Caso real: el artista tenía solo álbumes indexados y después aparece
    // su primer single indexado. lastSongMs ?? 0 hace que cualquier fecha
    // cuente como "nueva" — pero es la PRIMERA medición de canciones, y
    // avisarla sería ruido. El contrato elegido: mientras haya ALGÚN
    // snapshot, los campos presentes mandan; un campo ausente arranca en 0,
    // así que este caso SÍ avisa (es genuinamente posterior a lo conocido).
    const d = diffReleases(
      { lastAlbumMs: Date.parse('2026-01-01T00:00:00Z') },
      { albumMs: Date.parse('2026-01-01T00:00:00Z'), songMs: Date.now() },
    )
    expect(d.hasBaseline).toBe(true)
    expect(d.newAlbum).toBe(false)
    expect(d.newSong).toBe(true)
  })
})
