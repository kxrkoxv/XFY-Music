// Punto de entrada público del feature "player". Nadie fuera de esta
// carpeta debe importar directamente de player/components/* o
// player/store/*: todo pasa por acá.
//
// PlayerPage NO se re-exporta acá a propósito: es una ruta cargada con
// React.lazy() desde App.jsx (import directo al archivo). Si se
// exportara desde este barrel, cualquier import eager del barrel
// (AudioEngine, usePlayerStore, etc. — que App.jsx necesita siempre)
// arrastraría los ~600KB de PlayerPage al chunk inicial y anularía el
// code-splitting de esa ruta.
export { default as AudioEngine } from './components/AudioEngine'
export { default as YouTubeEngine } from './components/YouTubeEngine'
export { default as MediaSessionSync } from './components/MediaSessionSync'
export { default as MiniPlayerBar } from './components/MiniPlayerBar'
// MotionArt tampoco se re-exporta: solo lo usa PlayerPage (lazy) y trae
// hls.js (~32MB en node_modules) — exportarlo desde acá lo volvía
// eager y era la causa real de que el chunk inicial explotara a 666KB.
export { usePlayerStore } from './store/usePlayerStore'
export { useArtworkStore } from './store/useArtworkStore'
