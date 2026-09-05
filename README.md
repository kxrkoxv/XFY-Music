<div align="center">

# XFY

### Tu música. Sincronizada. En todas partes.

Un reproductor construido con React, con letras en tiempo real, cuentas
seguras y continuidad entre dispositivos.

</div>

<br>

<!--
  Reemplazá estos paths por tus propias imágenes:
    docs/screenshots/desktop.png
    docs/screenshots/mobile.png
-->

<p align="center">
  <img src="docs/screenshots/desktop.png" alt="XFY en escritorio" width="78%">
</p>
<p align="center">
  <img src="docs/screenshots/mobile.png" alt="XFY en móvil" width="24%">
</p>

<br>

## Descripción general

XFY busca y reproduce desde el catálogo de YouTube Music, muestra letras
sincronizadas palabra por palabra, y mantiene tu sesión y tu reproducción
consistentes entre dispositivos. Es una PWA — se instala, funciona sin
conexión donde tiene sentido, y se siente igual de bien en el escritorio
que en el bolsillo.

## Características

**Catálogo.** Búsqueda completa sobre YouTube Music. Portadas,
biografías y discografías se completan con iTunes, TheAudioDB,
MusicBrainz, Deezer y Wikipedia cuando hace falta.

**Letras en tiempo real.** Sincronización palabra por palabra vía
LRCLIB, con las letras nativas de YouTube Music como respaldo.

**Cuentas.** Registro con email y contraseña, passkeys (WebAuthn) y
verificación en dos pasos por TOTP con códigos de respaldo. También se
puede iniciar sesión con Spotify para importar tus playlists y tus me
gusta.

**Continuidad entre dispositivos.** Transferí la reproducción de una
computadora a un teléfono, o al revés, en tiempo real. Un canal directo
por WebSocket lo resuelve al instante; un mecanismo de respaldo garantiza
que funcione igual sin él.

**Reproducción instantánea.** El audio empieza a sonar de inmediato y,
en paralelo, se cachea en un almacenamiento propio de tres niveles para
que la próxima vez cargue directo, sin depender de YouTube.

**DJ con IA.** Comentarios breves entre canciones, generados a partir de
tus hábitos de escucha y leídos por el propio navegador — sin claves ni
servicios externos.

**Resumen y comparación.** Un resumen de tu escucha a lo largo del
tiempo, y una forma de comparar tu gusto musical con el de otra persona.

**Notificaciones.** Avisos cuando tus artistas favoritos publican algo
nuevo, incluso con la aplicación cerrada.

## Stack

| | |
|---|---|
| Frontend | React 19, Vite, TypeScript en modo estricto |
| Estado | Zustand |
| UI | Base UI, Motion, Sonner, Lucide |
| Enrutamiento | React Router 7 |
| Backend | Vercel Serverless Functions |
| Base de datos | Postgres (Neon) |
| Tiempo real | Ably, con long-poll como respaldo |
| Almacenamiento de audio | Cloudflare R2, Vercel Blob, Backblaze B2 |
| Autenticación | WebAuthn, TOTP, OAuth de Spotify |
| Calidad | oxlint, Vitest, Testing Library |

## Cómo funciona, en breve

**Catálogo.** Una función serverless corre `ytmusic-api`. En desarrollo,
un plugin de Vite ejecuta la misma función localmente, así que el
comportamiento es idéntico al de producción.

**Reproducción.** Cada canción se busca primero en el caché propio
(caliente a frío: R2, luego Blob, luego B2). Si no está, arranca al
instante desde YouTube mientras el audio se extrae y se guarda en
segundo plano para la próxima vez.

**Cuentas.** Postgres para usuarios, sesiones y credenciales. Contraseñas
con PBKDF2, passkeys vía WebAuthn, y TOTP con códigos de respaldo
hasheados.

**Sincronización.** Cada dispositivo abre un canal directo hacia Ably.
Un long-poll contra la base de datos actúa como respaldo permanente, y es
también el único canal para sincronizar cambios de cuenta —como nickname
o tema— entre dispositivos.

**Letras.** LRCLIB provee el timing palabra por palabra cuando está
disponible; en caso contrario, se estima. La búsqueda es tolerante a
ruido en los títulos y descarta coincidencias con duración incompatible.

**Lanzamientos.** El cliente revisa periódicamente si tus artistas más
escuchados sacaron algo nuevo, y un cron diario envía la notificación
aunque la aplicación esté cerrada.

## Estructura

```
api/                    Funciones serverless
  ytmusic.ts              Catálogo, búsqueda y letras
  ytcache.ts, ytaudio.ts  Extracción y caché de audio
  ytstream.ts, ytaudit.ts Streaming y auditoría del caché
  spotify.ts              Login de Spotify
  push.ts                 Web Push
  motionart.ts            Portadas animadas
  cron/                   Tareas programadas
  _lib/
    accountAuth.ts, accountDb.ts, accountResources.ts
    webauthn.ts, totp.ts
    realtime.ts
    tieredAudioStore.ts, r2Ledger.ts, s3Compat.ts
    ytcore.ts, ytstore.ts, remux.ts, tagAudio.ts
    rateLimit.ts, ssrfGuard.ts

public/                 Assets estáticos e íconos

src/
  main.tsx, App.tsx      Arranque y rutas
  sw.ts                  Service worker
  features/
    auth/                  Cuentas, passkeys, 2FA
    catalog/               Inicio, descubrimiento, búsqueda
    player/                Reproducción, cola, DJ con IA
    lyrics/                Motor de letras sincronizadas
    artists/               Artistas y discografías
    playlists/             Playlists e importación
    devices/               Sincronización entre dispositivos
    wrapped/               Resumen y comparación
    settings/              Preferencias y almacenamiento
  services/api/          Clientes de fuentes externas
  shared/                Componentes y utilidades comunes
  styles/                Estilos globales
```

Alias de imports (`vite.config.ts`): `@` → `src/`, además de
`@features`, `@shared`, `@services`.

## Desarrollo

```bash
npm install
npm run dev          # entorno de desarrollo
npm run test         # pruebas
npm run lint         # linting
npm run typecheck    # verificación de tipos
npm run build        # build de producción
```

## Despliegue

Diseñado para Vercel.

- Framework: Vite
- Comando de build: `npm run build`
- Directorio de salida: `dist`

### Variables de entorno

| Variable | Propósito |
|---|---|
| `DATABASE_URL` | Conexión a Postgres |
| `WEBAUTHN_RP_ID`, `WEBAUTHN_ORIGIN` | Configuración de passkeys |
| `BLOB_READ_WRITE_TOKEN` | Caché de audio, nivel intermedio |
| `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`, `R2_PUBLIC_BASE_URL` | Caché de audio, nivel principal |
| `B2_KEY_ID`, `B2_APPLICATION_KEY`, `B2_ENDPOINT`, `B2_BUCKET`, `B2_PUBLIC_BASE_URL` | Caché de audio, nivel de archivo |
| `VITE_R2_BASE_URL`, `VITE_BLOB_BASE_URL`, `VITE_B2_BASE_URL` | Lectura pública desde el cliente |
| `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`, `VITE_SPOTIFY_CLIENT_ID` | Login de Spotify |
| `ABLY_API_KEY` | Sincronización en tiempo real (opcional) |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VITE_VAPID_PUBLIC_KEY` | Notificaciones push |
| `ADMIN_TOKEN` | Auditoría manual del caché |
| `CRON_SECRET` | Autorización de tareas programadas |

Los tres niveles de almacenamiento de audio son independientes entre sí.
Sin ninguno configurado, la aplicación sigue funcionando: cada canción se
reproduce directo desde YouTube, sin el acelerador del caché.

<details>
<summary>Variables opcionales para YouTube</summary>

- `YTMUSIC_COOKIE`, `YTDL_COOKIE` — cookies de sesión, para cuando
  aparecen bloqueos consistentes.
- `YT_AUDIO_CLIENT` — cliente de extracción a utilizar.
- `YT_PROXY_URL` — proxy saliente para mitigar bloqueos por reputación
  de IP.
- `YT_DISABLE_EXTERNAL_FALLBACK` — desactiva las fuentes externas de
  respaldo.

</details>

## Contribuir

Las contribuciones son bienvenidas. Abrí un issue antes de un cambio
grande, y corré `npm run lint` y `npm run typecheck` antes de un pull
request.

## Licencia

Distribuido bajo la GNU Affero General Public License v3.0 (AGPL-3.0).
Podés usar, modificar y contribuir libremente; si desplegás una versión
modificada como servicio público, esa versión también debe compartirse.
Ver [`LICENSE`](./LICENSE).
