import { useEffect, useRef, useState } from 'react'
import { getCachedAssetUrl } from './cacheManager'

/** Resuelve `src` a través del caché de assets y devuelve la URL lista
 *  para pintar (la original o un blob: URL del Cache Storage). */
export function useCachedImageSrc(src: string | null | undefined): string | null {
  const [resolvedSrc, setResolvedSrc] = useState<string | null>(() => src || null)
  const objectUrlRef = useRef<string | null>(null)
  // Sentinel distinto de cualquier `src` real (incluido undefined/null) para
  // que la comparación de abajo SIEMPRE dispare el caché en el primer
  // montaje — antes se inicializaba con el propio `src`, así que la
  // primera corrida del effect (la de cada imagen nueva que aparece en
  // pantalla) nunca llamaba a getCachedAssetUrl y la imagen jamás quedaba
  // guardada en Cache Storage.
  const prevSrcRef = useRef<symbol | string>(Symbol('uncached'))
  const nullSetRef = useRef(false)

  useEffect(() => {
    let cancelled = false

    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current)
      objectUrlRef.current = null
    }

    if (!src) {
      if (!nullSetRef.current) {
        setResolvedSrc(null)
        nullSetRef.current = true
      }
      return undefined
    }
    nullSetRef.current = false

    if (prevSrcRef.current !== src) {
      setResolvedSrc(src)
      getCachedAssetUrl(src, src, 'image').then((url) => {
        if (cancelled) return
        if (url.startsWith('blob:')) objectUrlRef.current = url
        setResolvedSrc(url)
      })
      prevSrcRef.current = src
    }

    return () => {
      cancelled = true
    }
  }, [src])

  useEffect(
    () => () => {
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current)
    },
    [],
  )

  return resolvedSrc
}
