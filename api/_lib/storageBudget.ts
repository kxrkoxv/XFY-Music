/**
 * Topes de capacidad compartidos entre el cron de lifecycle
 * (api/cron/r2-lifecycle.ts) y la escritura proactiva
 * (tieredAudioStore.ts). Antes cada archivo definía sus propios números
 * sueltos — quedaban desincronizados apenas alguien tocaba uno y se
 * olvidaba del otro. Ahora hay una sola fuente de verdad.
 *
 * R2_SOFT_CAP_BYTES / R2_TARGET_BYTES dejan un colchón de 1 GB antes de
 * los 10 GB gratis de Cloudflare R2 — no es solo margen de error del
 * listado (que es exacto), sino margen para el tiempo que pasa ENTRE
 * que algo se escribe y la próxima corrida del cron/lectura del ledger
 * lo refleja.
 */
export const R2_FREE_TIER_BYTES = 10 * 1024 * 1024 * 1024
export const R2_SOFT_CAP_BYTES = 9 * 1024 * 1024 * 1024 // 9 de 10 GB gratis
export const R2_TARGET_BYTES = 7.5 * 1024 * 1024 * 1024

export const B2_FREE_TIER_BYTES = 10 * 1024 * 1024 * 1024
export const B2_HARD_CAP_BYTES = 9 * 1024 * 1024 * 1024 // 9 de 10 GB gratis
export const B2_TARGET_BYTES = 7 * 1024 * 1024 * 1024

export const COLD_AFTER_MS = 21 * 24 * 60 * 60 * 1000 // 21 días sin revalidarse = frío

/**
 * Cache-Control para el audio: el contenido es inmutable (path
 * determinístico por videoId, un archivo nunca se pisa con contenido
 * distinto — ytaudit.js lo reemplaza entero si está corrupto, no lo
 * "actualiza"). `immutable` + max-age de 1 año le dice a Cloudflare que
 * puede servir esto desde el edge cache SIN volver a pegarle al bucket
 * de origen — que es la diferencia entre "una operación Class B por
 * reproducción" y "una operación Class B por reproducción DE TODO
 * INTERNET la primera vez, cero después". Es la palanca real contra
 * gastar el millón de operaciones Class A / 10 millones Class B
 * gratis: el conteo de operaciones de R2 solo ve los cache MISSES.
 *
 * OJO — esto depende de que el dominio público de R2 tenga habilitada
 * una Cache Rule "Cache Everything" en Cloudflare (el comportamiento
 * default de un dominio propio sobre R2 NO cachea todo el contenido
 * solo por mandar este header). Verificar en el dashboard de Cloudflare:
 * Caching → Cache Rules.
 */
export const IMMUTABLE_AUDIO_CACHE_CONTROL = 'public, max-age=31536000, immutable'
