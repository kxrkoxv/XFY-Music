import { useEffect, useState } from 'react'

// true solo donde hay cursor real (mouse/trackpad). En táctil los
// navegadores disparan :hover / whileHover al TOCAR y el estado queda
// pegado hasta tocar otro lado, así que cualquier hover que mueva
// transform debe gatearse con esto (los que solo cambian color/fondo
// no hacen falta). Complementa useReducedMotion: cubren cosas distintas.
export default function useCanHover() {
  const query = '(hover: hover) and (pointer: fine)'
  const [canHover, setCanHover] = useState(
    () =>
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia(query).matches,
  )

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return undefined
    const mq = window.matchMedia(query)
    const onChange = (e: MediaQueryListEvent) => setCanHover(e.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])

  return canHover
}
