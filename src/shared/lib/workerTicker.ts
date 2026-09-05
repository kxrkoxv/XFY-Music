// ============================================================
// Intervalo inmune al throttling de pestañas ocultas.
//
// Los navegadores recortan setInterval/setTimeout a ~1 vez por minuto
// cuando la pestaña está oculta (y más agresivo en móvil). Para el
// player eso rompe exactamente lo que importa en segundo plano: el
// polling de "¿ya subió el blob?" y el watchdog de auto-sanación.
//
// Un Web Worker NO se throttlea: corre en su propio hilo con timers
// plenos, y solo nos manda un postMessage por tick — el callback corre
// en el main thread como cualquier evento. Fallback transparente a
// setInterval si Workers no están disponibles (CSP estricto, etc.).
// ============================================================

let workerUrlCache: string | null = null

function getWorkerUrl(ms: number): string {
  // El intervalo va horneado dentro del worker (cada ms necesita su propio
  // script); cacheamos la URL por ms para no crear blobs repetidos.
  const key = `xfy-worker-ticker-${ms}`
  if (workerUrlCache && workerUrlCache.includes(key)) return workerUrlCache
  const src = [
    `// xfy ticker ${key}`,
    `let t=null;`,
    `onmessage=(e)=>{`,
    `  if(e.data==='start'){ if(t)clearInterval(t); t=setInterval(()=>postMessage(0), ${ms}); }`,
    `  else if(e.data==='stop'){ if(t)clearInterval(t); t=null; }`,
    `}`,
  ].join('\n')
  workerUrlCache = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }))
  return workerUrlCache
}

/**
 * Ejecuta `cb` cada `ms` sin throttling en segundo plano.
 * Devuelve la función de limpieza. Si falla la creación del Worker,
 * cae a setInterval normal (peor pero funcional).
 */
export function createWorkerInterval(cb: () => void, ms: number): () => void {
  let worker: Worker | null = null
  let fallbackId: number | null = null

  try {
    worker = new Worker(getWorkerUrl(ms))
    worker.onmessage = () => {
      try {
        cb()
      } catch {
        /* un tick roto nunca debe matar el ticker */
      }
    }
    worker.postMessage('start')
  } catch {
    worker = null
    fallbackId = window.setInterval(() => {
      try {
        cb()
      } catch {
        /* noop */
      }
    }, ms)
  }

  return () => {
    if (worker) {
      try {
        worker.postMessage('stop')
        worker.terminate()
      } catch {
        /* noop */
      }
      worker = null
    }
    if (fallbackId !== null) {
      window.clearInterval(fallbackId)
      fallbackId = null
    }
  }
}
