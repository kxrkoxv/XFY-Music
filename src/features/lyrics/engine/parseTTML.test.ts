import { describe, it, expect, beforeEach } from 'vitest'
import { parseTTML, type TTMLLine } from './parseTTML'

const TTML_DUO = `<?xml version="1.0" encoding="UTF-8"?>
<tt xmlns="http://www.w3.org/ns/ttml" xmlns:ttm="http://www.w3.org/ns/ttml#metadata">
  <body>
    <div>
      <p begin="0.5s" end="4s" ttm:agent="v1">
        <span begin="0.5s" end="1.2s">Hola</span>
        <span begin="1.2s" end="2s">mundo</span>
        <span ttm:role="x-translation">Hola mundo</span>
      </p>
      <p begin="4s" end="7s" ttm:agent="v2">
        <span begin="4s" end="5s">Que</span>
        <span begin="5s" end="6.5s">tal</span>
      </p>
      <p begin="7s" end="9s" ttm:agent="v1">
        <span begin="7s" end="8s">principal</span>
        <span ttm:role="x-bg"><span begin="7.2s" end="8.2s">coro</span></span>
      </p>
    </div>
  </body>
</tt>`

describe('parseTTML', () => {
  let lines: TTMLLine[]
  beforeEach(() => {
    lines = parseTTML(TTML_DUO)
  })

  it('parsea las tres líneas con su begin de línea', () => {
    expect(lines).toHaveLength(3)
    expect(lines.map((l) => l.time)).toEqual([0.5, 4, 7])
  })

  it('extrae timing por palabra de los spans con begin', () => {
    expect(lines[0]?.words).toEqual([
      { text: 'Hola', start: 0.5, end: 1.2 },
      { text: 'mundo', start: 1.2, end: 2 },
    ])
  })

  it('arma el texto plano concatenando las palabras (sin espacios extra)', () => {
    expect(lines[0]?.text).toBe('Holamundo')
  })

  it('detecta traducción asociada a la línea', () => {
    expect(lines[0]?.translation).toBe('Hola mundo')
    expect(lines[1]?.translation).toBeUndefined()
  })

  it('marca oppositeAligned en el agente secundario del dúo', () => {
    // v1 es el agente primario (primera línea); la línea de v2 va al otro lado
    expect(lines[0]?.oppositeAligned).toBeUndefined()
    expect(lines[1]?.oppositeAligned).toBe(true)
    expect(lines[2]?.oppositeAligned).toBeUndefined()
  })

  it('separa voces de fondo (ttm:role=x-bg)', () => {
    expect(lines[2]?.background).toEqual([{ text: 'coro', start: 7.2, end: 8.2 }])
  })

  it('línea sin spans con timing cae al textContent como fallback', () => {
    const ttml = `<tt><body><div><p begin="1s" end="2s">Solo texto plano</p></div></body></tt>`
    const out = parseTTML(ttml)
    expect(out).toHaveLength(1)
    expect(out[0]?.text).toBe('Solo texto plano')
    expect(out[0]?.words).toBeUndefined()
  })

  it('XML inválido → []', () => {
    expect(parseTTML('esto no es xml <<<')).toEqual([])
  })

  it('sin párrafos → []', () => {
    expect(parseTTML('<tt><body><div></div></body></tt>')).toEqual([])
  })

  it('acepta los formatos de tiempo del estándar TTML (regresión: "0.5s" quedaba en 0)', () => {
    const ttml = `<tt><body><div>
      <p begin="0.5s" end="2s"><span begin="500ms" end="1s">uno</span></p>
      <p begin="01:02.5" end="00:01:03"><span begin="62.5s" end="63s">dos</span></p>
    </div></body></tt>`
    const out = parseTTML(ttml)
    expect(out.map((l) => l.time)).toEqual([0.5, 62.5])
    expect(out[0]?.words?.[0]).toEqual({ text: 'uno', start: 0.5, end: 1 })
    expect(out[1]?.words?.[0]).toEqual({ text: 'dos', start: 62.5, end: 63 })
  })
})
