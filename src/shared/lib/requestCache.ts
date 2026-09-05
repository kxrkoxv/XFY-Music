// ============================================================
// Cache genérico de requests en localStorage, con TTL configurable por
// llamada. Varios providers (audiodb.js, musicbrainz.js, wikipedia.js,
// lrclib.js) ya venían reimplementando el mismo patrón
// (readCache/writeCache/cacheKeyFor con TTL) cada uno por su cuenta —
// esto lo saca a un solo lugar para no seguir copiando la misma lógica
// una vez más por cada API nueva (como ytmusic.js, que hasta ahora
// pegaba a la red SIEMPRE, hasta para la misma búsqueda repetida en la
// misma sesión).
//
// El TTL importa: no todo tipo de dato envejece igual. Una búsqueda
// puede traer resultados distintos si la pedís de nuevo en una semana
// (nueva música salió); el catálogo de un artista cambia poco; las
// letras de una canción no cambian nunca. Por eso cada provider define
// su propio TTL según el tipo de solicitud, en vez de un valor único
// para todo.
// ============================================================

const PREFIX = 'xfy_reqcache_'

interface CacheEntry<T> {
  value: T
  fetchedAt: number
}

function readEntry<T>(fullKey: string): CacheEntry<T> | null {
  try {
    const raw = localStorage.getItem(fullKey)
    return raw ? (JSON.parse(raw) as CacheEntry<T>) : null
  } catch {
    return null
  }
}

function writeEntry<T>(fullKey: string, entry: CacheEntry<T>): void {
  try {
    localStorage.setItem(fullKey, JSON.stringify(entry))
  } catch {
    // localStorage lleno o no disponible — no es crítico, el próximo
    // pedido simplemente vuelve a golpear la red.
  }
}

// `namespace`: agrupa las claves por API (ej. "ytmusic-search") para que
// invalidar/inspeccionar un tipo de dato puntual sea simple.
// `key`: identifica la solicitud puntual dentro de ese namespace (ej. el
// término de búsqueda).
// `ttlMs`: hace cuánto tiempo se considera "fresco" un resultado
// cacheado.
// `fetcher`: función async que trae el dato real si no hay caché válido.
// `isCacheable`: predicado opcional sobre el valor resuelto. Por default
// cualquier resultado exitoso es cacheable — pero para respuestas que
// pueden venir "vacías" sin ser técnicamente un error (ej. una playlist
// sin canciones por un fallo transitorio upstream), un caller puede pasar
// un predicado para que ESO tampoco se guarde ni se sirva desde caché.
// Sin esto, una respuesta vacía queda "envenenando" el caché del
// navegador durante todo el TTL, incluso después de arreglar el bug que
// la causó del lado del servidor — el fix del backend no alcanza si el
// browser sigue sirviendo la respuesta vieja desde localStorage.
//
// Los fallos de `fetcher` NUNCA se cachean (si la red falla ahora, el
// próximo intento debe golpear la red de nuevo, no repetir el mismo
// error guardado).
// Pedidos en vuelo, por clave completa: si dos llamadores piden lo mismo
// (misma namespace+key) mientras todavía no hay nada cacheado, comparten
// UNA sola ejecución de `fetcher` en vez de disparar dos pedidos a la red
// en paralelo. Sin esto, por ejemplo, el doble efecto de React StrictMode
// en desarrollo — o dos componentes de la misma página pidiendo el mismo
// artista a la vez — duplicaba cada request.
const inFlightByKey = new Map<string, Promise<unknown>>()

/**
 * `isCacheable` acota T: por default cualquier valor resuelto es
 * cacheable; un predicado permite rechazar respuestas "vacías pero
 * exitosas" para que no envenenen el caché (ver comentario largo arriba).
 */
export async function cachedFetch<T>(
  namespace: string,
  key: string,
  ttlMs: number,
  fetcher: () => Promise<T>,
  isCacheable: (value: T) => boolean = () => true,
): Promise<T> {
  const fullKey = `${PREFIX}${namespace}:${String(key).toLowerCase().trim()}`
  const cached = readEntry(fullKey) as { value: T; fetchedAt: number } | null
  if (cached && Date.now() - cached.fetchedAt < ttlMs && isCacheable(cached.value)) {
    return cached.value
  }

  const inFlight = inFlightByKey.get(fullKey) as Promise<T> | undefined
  if (inFlight) return inFlight

  const promise = (async () => {
    try {
      const value = await fetcher()
      if (isCacheable(value)) {
        writeEntry(fullKey, { value, fetchedAt: Date.now() })
      }
      return value
    } finally {
      inFlightByKey.delete(fullKey)
    }
  })()

  inFlightByKey.set(fullKey, promise)
  return promise
}
