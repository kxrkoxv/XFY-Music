/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Base pública del store de audio en Cloudflare R2 — nivel HOT, ver
   *  tieredAudioStore.ts / ytblob.ts. Es el dominio público que apunta al
   *  bucket R2 (custom domain o r2.dev), NO el endpoint S3 de escritura. */
  readonly VITE_R2_BASE_URL?: string
  /** Base pública del blob store de audio legacy (ver ytblob.js). */
  readonly VITE_BLOB_BASE_URL?: string
  /** Base pública del store de audio en Backblaze B2 — nivel frío, ver
   *  tieredAudioStore.ts / ytblob.ts. */
  readonly VITE_B2_BASE_URL?: string
  /** Client ID público de la app de Spotify — usado en el navegador para
   *  armar la URL de autorización del login real (Authorization Code +
   *  PKCE, ver pkce.ts / spotifyAuth.ts). El client secret NUNCA viaja
   *  acá: vive solo en el servidor (api/spotify.ts), como
   *  SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET. */
  readonly VITE_SPOTIFY_CLIENT_ID?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

/** Network Information API — solo Chrome/Edge; se usa best-effort para
 *  cortar el prefetch si el usuario está en modo ahorro de datos. */
interface Navigator {
  readonly connection?: { saveData?: boolean; effectiveType?: string }
}
