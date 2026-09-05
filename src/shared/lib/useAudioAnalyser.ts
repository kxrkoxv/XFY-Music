import { useEffect, useRef, useState } from 'react'

/**
 * Conecta un <audio> a un AnalyserNode de Web Audio para poder leer sus
 * frecuencias en tiempo real (visualizador). Reglas de seguridad, porque
 * el motor de audio de XFY es delicado (fallback a IFrame de YouTube,
 * recreación del <audio> en iOS, Media Session):
 *
 *  1. NUNCA se llama si no hay un componente montado pidiéndolo (el store
 *     expone audioVisualizerEnabled, apagado por defecto) — cero costo
 *     para quien no usa el visualizer.
 *  2. `createMediaElementSource(el)` solo puede llamarse UNA VEZ por
 *     elemento en toda la vida de la página (si se llama dos veces tira).
 *     Por eso el grafo (ctx/source/analyser) se cachea en un WeakMap por
 *     elemento — si `usePlayerStore` recrea el <audio> (cura de WebKit),
 *     simplemente se arma un grafo nuevo para el elemento nuevo.
 *  3. El grafo SIEMPRE reconecta a `ctx.destination` (source → analyser →
 *     destination): la reproducción real sigue sonando exactamente igual,
 *     el analyser solo "escucha" de paso.
 *  4. Cualquier error (audio cross-origin sin CORS, AudioContext no
 *     soportado, contexto suspendido por autoplay policy, etc.) se traga
 *     en silencio y el hook devuelve `null` — el visualizer de arriba debe
 *     tratar `null` como "no hay datos todavía", nunca como fatal.
 */

interface AnalyserGraph {
  ctx: AudioContext
  analyser: AnalyserNode
}

const graphCache = new WeakMap<HTMLAudioElement, AnalyserGraph>()

function getOrCreateGraph(el: HTMLAudioElement): AnalyserGraph | null {
  const cached = graphCache.get(el)
  if (cached) return cached
  try {
    const AudioContextCtor = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!AudioContextCtor) return null
    const ctx = new AudioContextCtor()
    const source = ctx.createMediaElementSource(el)
    const analyser = ctx.createAnalyser()
    analyser.fftSize = 256
    analyser.smoothingTimeConstant = 0.75
    source.connect(analyser)
    analyser.connect(ctx.destination)
    const graph = { ctx, analyser }
    graphCache.set(el, graph)
    return graph
  } catch {
    // Cross-origin sin CORS, navegador sin soporte, o el elemento ya
    // estaba conectado a otro contexto (no debería pasar con el cache,
    // pero por las dudas no rompemos nada).
    return null
  }
}

/**
 * Devuelve una función `getLevels()` que lee el espectro actual (0-255 por
 * banda) bajo demanda, pensada para llamarse desde un requestAnimationFrame
 * propio del componente visual (no dispara re-renders de React por sí sola).
 * `active` controla si el hook siquiera intenta conectar el grafo.
 */
export function useAudioAnalyser(
  audioEl: HTMLAudioElement | null,
  active: boolean,
): { getLevels: () => Uint8Array<ArrayBuffer> | null; ready: boolean } {
  const graphRef = useRef<AnalyserGraph | null>(null)
  const dataRef = useRef<Uint8Array<ArrayBuffer> | null>(null)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    if (!active || !audioEl) {
      graphRef.current = null
      dataRef.current = null
      setReady(false)
      return undefined
    }

    const graph = getOrCreateGraph(audioEl)
    graphRef.current = graph
    if (graph) {
      dataRef.current = new Uint8Array(new ArrayBuffer(graph.analyser.frequencyBinCount))
      // Los navegadores arrancan el AudioContext suspendido hasta un gesto
      // del usuario; para cuando el visualizer se monta ya hubo un tap en
      // "play", así que esto normalmente resuelve al toque.
      void graph.ctx.resume().catch(() => {})
    }
    setReady(!!graph)

    return () => {
      // No se cierra el AudioContext ni se desconecta nada: el grafo queda
      // vivo en el WeakMap por si el visualizer se vuelve a montar para la
      // misma pista (evita el error de "elemento ya conectado" al reabrir).
    }
  }, [audioEl, active])

  const getLevels = (): Uint8Array<ArrayBuffer> | null => {
    const graph = graphRef.current
    const data = dataRef.current
    if (!graph || !data) return null
    graph.analyser.getByteFrequencyData(data)
    return data
  }

  return { getLevels, ready }
}
