import { useEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'

/**
 * true una sola vez que `ref` entra (o está cerca de entrar, según
 * `rootMargin`) al viewport — después no vuelve a false ni se
 * desconecta y reconecta el observer, así que sirve para gatear
 * trabajo de red que solo debe dispararse una vez por elemento
 * (resolver portada, cachear imagen).
 *
 * Pensado para listas largas sin virtualizar (ver CachedImg.tsx):
 * cada fila monta igual (no hay windowing), pero el trabajo caro
 * — resolve() a Apple, fetch a Cache Storage — se posterga hasta
 * que la fila realmente está por verse, en vez de dispararse las
 * 460 veces apenas se pinta la lista completa.
 */
const supportsIntersectionObserver = typeof IntersectionObserver !== 'undefined'

export function useInViewOnce<T extends Element>(rootMargin = '600px 0px'): [RefObject<T | null>, boolean] {
  const ref = useRef<T | null>(null)
  // Sin soporte de IntersectionObserver (muy raro hoy, pero por las dudas):
  // arranca ya "visible" desde el estado inicial en vez de setearlo dentro
  // del efecto — evita un render extra innecesario para ese caso.
  const [inView, setInView] = useState(() => !supportsIntersectionObserver)

  useEffect(() => {
    if (inView || !supportsIntersectionObserver) return undefined
    const el = ref.current
    if (!el) return undefined

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setInView(true)
          observer.disconnect()
        }
      },
      { rootMargin },
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [inView, rootMargin])

  return [ref, inView]
}
