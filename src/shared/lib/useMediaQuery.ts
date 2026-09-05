import { useEffect, useState } from 'react'

// Hook genérico para ramas de layout que CSS solo no puede resolver (ej.
// decidir en JS si mostrar la lista de categorías o el panel de contenido
// en Ajustes estilo Discord). Para todo lo que sea puramente visual, sigue
// yendo en CSS con @media — esto es solo para cuando el árbol de componentes
// necesita bifurcarse.
export default function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(
    () => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(query).matches,
  )

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return undefined
    const mq = window.matchMedia(query)
    setMatches(mq.matches)
    const onChange = (e: MediaQueryListEvent) => setMatches(e.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [query])

  return matches
}
