export function asPublicAsset(path: string | null | undefined): string | null {
  if (!path) return null
  if (/^(https?:)?\/\//.test(path) || path.startsWith('data:') || path.startsWith('blob:')) return path
  return `/${path.replace(/^\.?\//, '')}`
}

// Portadas del catálogo local vienen hotlinkeadas de resultados de
// búsqueda de imágenes (Bing) — links que a veces devuelven 404 (el
// hosting expira, cambia de ruta, etc.). En vez de mostrar el ícono
// "imagen rota" del navegador, esto cambia el <img> a un placeholder
// propio una sola vez (evita loop infinito si el placeholder también
// fallara). Uso: <img onError={handleArtworkError} ... />.
export function handleArtworkError(event: React.SyntheticEvent<HTMLImageElement>): void {
  const img = event.currentTarget
  if (img.dataset.fallback === '1') return
  img.dataset.fallback = '1'
  img.src = '/icons/icon-192.svg'
}

// Convierte un File de imagen (elegido por el usuario, p. ej. portada
// personalizada de una playlist) a un dataURL cuadrado y comprimido.
// Recortar/achicar client-side evita guardar fotos de varios MB tal cual
// en IndexedDB — cada playlist termina pesando unos pocos KB en vez de
// arrastrar el archivo original completo.
export function fileToResizedDataUrl(file: File | null | undefined, size = 500, quality = 0.85): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!file || !file.type?.startsWith('image/')) {
      reject(new Error('El archivo elegido no es una imagen.'))
      return
    }
    const img = new Image()
    const objectUrl = URL.createObjectURL(file)
    img.onload = () => {
      URL.revokeObjectURL(objectUrl)
      const side = Math.min(img.width, img.height)
      const sx = (img.width - side) / 2
      const sy = (img.height - side) / 2
      const canvas = document.createElement('canvas')
      canvas.width = size
      canvas.height = size
      const ctx = canvas.getContext('2d')
      if (!ctx) {
        reject(new Error('No se pudo crear el canvas para redimensionar la imagen.'))
        return
      }
      ctx.drawImage(img, sx, sy, side, side, 0, 0, size, size)
      resolve(canvas.toDataURL('image/jpeg', quality))
    }
    img.onerror = () => {
      URL.revokeObjectURL(objectUrl)
      reject(new Error('No se pudo leer la imagen.'))
    }
    img.src = objectUrl
  })
}
