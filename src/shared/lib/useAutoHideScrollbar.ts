import { useEffect, useRef } from 'react'
import type { RefObject } from 'react'

// Alterna una clase `.is-scrolling` en el elemento mientras hay scroll
// activo (y la quita 700ms después de que para). Combinado con
// `styles/scrollbars.css`, esto hace que el thumb del scrollbar aparezca
// solo cuando hace falta (scrolleando o con el mouse encima) en vez de
// estar siempre visible — el mismo truco que usan las apps nativas.
export function useAutoHideScrollbar<T extends HTMLElement = HTMLElement>(): RefObject<T | null> {
  const ref = useRef<T | null>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return

    let timeout: number | undefined
    const onScroll = () => {
      el.classList.add('is-scrolling')
      window.clearTimeout(timeout)
      timeout = window.setTimeout(() => el.classList.remove('is-scrolling'), 700)
    }

    el.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      el.removeEventListener('scroll', onScroll)
      window.clearTimeout(timeout)
    }
  }, [])

  return ref
}
