import { useEffect, useState } from 'react'
import { blurhashToDataUrl, getBlurhash } from './blurhashCache'

/**
 * Devuelve un data URL borroso (basado en un blurhash ya calculado en una
 * visita anterior) para usar como placeholder de `src` mientras la imagen
 * real todavía no cargó. Devuelve null si esa portada nunca se vio antes
 * (primera vez) — en ese caso el fallback de degradado genérico sigue
 * siendo lo que se pinta, y CachedImg se encarga de calcular el blurhash
 * una vez que la imagen real cargue, para la próxima visita.
 */
export function useBlurhashPlaceholder(src: string | null | undefined): string | null {
  const [placeholder, setPlaceholder] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setPlaceholder(null)
    if (!src) return undefined

    getBlurhash(src).then((hash) => {
      if (cancelled || !hash) return
      const dataUrl = blurhashToDataUrl(hash)
      if (!cancelled && dataUrl) setPlaceholder(dataUrl)
    })

    return () => {
      cancelled = true
    }
  }, [src])

  return placeholder
}
