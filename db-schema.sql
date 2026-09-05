-- XFY — schema Postgres (Neon)
-- Correr una sola vez contra la DB nueva (SQL editor de Neon, o `psql $DATABASE_URL -f schema.sql`).
--
-- Si tu DB tiene tablas `devices`/`playback_commands` de una versión previa
-- e incompatible (otras columnas a las definidas más abajo — por ejemplo,
-- de antes de que este sistema tuviera backend real), volalas antes de
-- correr esto: `create table if not exists` no migra un esquema que ya
-- existe con otra forma:
--   drop table if exists playback_commands;
--   drop table if exists devices;

create extension if not exists pgcrypto; -- gen_random_uuid()

create table if not exists users (
  id            uuid primary key default gen_random_uuid(),
  nickname      text not null,
  email         text not null unique,
  password_hash text not null,               -- formato "saltHex:hashHex", mismo PBKDF2 que usaba IndexedDB
  avatar_url    text,
  preferences   jsonb not null default '{}'::jsonb,  -- theme, volume, playbackSpeed, autoPlayNext, favorites[], spotifyAuth
  -- --- Seguridad tipo Discord: 2FA por TOTP + códigos de respaldo -----------
  -- totp_secret: base32, sólo tiene efecto real una vez que totp_enabled es
  -- true (setupStart lo escribe antes de confirmar; si el usuario abandona
  -- el flujo, queda un secret "huérfano" pero inofensivo — el siguiente
  -- intento de setup lo pisa). backup_codes: array de {hash, usedAt} —
  -- SHA-256 de cada código, nunca el código en texto plano (igual criterio
  -- que password_hash, ver totp.ts).
  totp_secret     text,
  totp_enabled    boolean not null default false,
  backup_codes    jsonb not null default '[]'::jsonb,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- Sesiones = un token por login. expires_at: antes las sesiones no vencían
-- nunca (un token robado o filtrado servía para siempre). Ahora cada login
-- expira a los 30 días (ver SESSION_TTL_MS en accountAuth.ts) y
-- requireAuth() lo valida.
-- device_name/user_agent/ip/last_seen_at: metadata para que el usuario
-- pueda ver "dónde" está cada sesión activa y cerrarlas individualmente
-- desde Ajustes → Seguridad (mismo patrón que Discord/Google) — no
-- confundir con la tabla `devices` de sincronización de reproducción
-- (esa se sacó, ver el DROP de arriba); esto es pura auditoría de login.
create table if not exists sessions (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references users(id) on delete cascade,
  token         text not null unique,          -- bearer token que guarda el cliente
  device_name   text,                          -- etiqueta legible derivada del User-Agent, ver deviceLabel.ts
  user_agent    text,
  ip            text,
  created_at    timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  expires_at    timestamptz not null default now() + interval '30 days'
);
create index if not exists sessions_user_id_idx on sessions(user_id);
create index if not exists sessions_expires_at_idx on sessions(expires_at);

-- Passkeys (WebAuthn) — una fila por credencial registrada. id = el
-- credential id que manda el browser (base64url), NO un uuid generado acá,
-- porque es justamente lo que usamos para encontrar la fila al verificar
-- un login.
create table if not exists webauthn_credentials (
  id           text primary key,
  user_id      uuid not null references users(id) on delete cascade,
  public_key   text not null,      -- clave pública COSE, base64
  counter      bigint not null default 0,
  transports   jsonb not null default '[]'::jsonb,
  device_name  text not null default 'Passkey',
  created_at   timestamptz not null default now(),
  last_used_at timestamptz
);
create index if not exists webauthn_credentials_user_id_idx on webauthn_credentials(user_id);

-- Challenges efímeros de las ceremonias WebAuthn (registro/login) y del
-- segundo factor pendiente durante un login con contraseña + TOTP. Vive
-- poco (5 min) porque no hay estado de sesión entre "pedir el challenge" y
-- "verificarlo" en un backend serverless — esta tabla ES ese estado.
create table if not exists auth_challenges (
  id         text primary key,     -- token random que el cliente devuelve para identificar SU challenge
  user_id    uuid references users(id) on delete cascade,  -- null en login passwordless (todavía no se sabe quién es)
  type       text not null,        -- 'webauthn-register' | 'webauthn-auth' | '2fa-login'
  challenge  text not null default '',  -- challenge base64url (vacío para 2fa-login, no aplica)
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '5 minutes'
);
create index if not exists auth_challenges_expires_idx on auth_challenges(expires_at);

-- Rate limiting por IP (login/registro) — ver api/_lib/rateLimit.ts.
-- Ventana fija: `count` se resetea solo cuando `reset_at` ya pasó.
create table if not exists rate_limits (
  key       text primary key,
  count     integer not null default 1,
  reset_at  timestamptz not null
);

-- Catálogo de canciones: guarda cada canción UNA sola vez (metadata completa
-- de YT Music/etc: título, artista, albumArtUrl...), sin importar en cuántas
-- playlists o favoritos aparezca. playlists.songs pasa a ser un array de IDs
-- que referencian esta tabla, no objetos completos duplicados por cada uso.
create table if not exists songs (
  id         text primary key,
  data       jsonb not null,
  updated_at timestamptz not null default now()
);

create table if not exists playlists (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references users(id) on delete cascade,
  name        text not null,
  description text not null default '',
  cover_url   text,
  songs       jsonb not null default '[]'::jsonb,  -- array de IDs (string), NO objetos completos — ver tabla songs arriba
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists playlists_user_id_idx on playlists(user_id);

create table if not exists custom_themes (
  id         text primary key,   -- se conserva el id que ya traían los temas migrados
  user_id    uuid not null references users(id) on delete cascade,
  name       text not null,
  colors     jsonb not null,
  created_at timestamptz not null default now()
);
create index if not exists custom_themes_user_id_idx on custom_themes(user_id);

-- Dispositivos conectados a la cuenta ("Spotify Connect" de XFY, ver
-- src/features/devices/ y la sección `devices` de accountResources.ts) —
-- cada fila es una INSTALACIÓN de navegador/PWA (device_key = xfy_client_
-- device_id de localStorage, ver getDeviceId() en apiClient.ts), no un
-- login: la misma sesión puede pisar varios device_key si el usuario borra
-- storage, y un device_key sobrevive a relogins (arrastra un session_id
-- nuevo en cada heartbeat). is_active = "quién tiene el mando ahora mismo"
-- — sólo uno por cuenta a la vez (ver el UPDATE atómico en heartbeat/
-- transfer). player_state = último heartbeat que mandó ESE dispositivo
-- (null si no tiene nada cargado).
create table if not exists devices (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references users(id) on delete cascade,
  device_key   text not null,
  session_id   uuid references sessions(id) on delete set null,
  name         text not null,
  name_custom  boolean not null default false,  -- true una vez que el usuario lo renombra a mano — el heartbeat deja de pisarlo
  kind         text not null default 'web',     -- 'web' | 'mobile' | 'desktop' — heurística sobre el User-Agent
  is_active    boolean not null default false,
  player_state jsonb,
  last_seen_at timestamptz not null default now(),
  created_at   timestamptz not null default now(),
  unique (user_id, device_key)
);
create index if not exists devices_user_id_idx on devices(user_id, last_seen_at desc);

-- Comandos pendientes de entregar a un dispositivo puntual (play/pause/seek/
-- setVolume/next/previous/transfer/revoked) — filas de vida corta, se borran
-- apenas pollCommands las entrega (o a los 2 min si nadie preguntó, ver el
-- DELETE oportunista en accountResources.ts). Ably (api/_lib/realtime.ts) es
-- la vía rápida cuando está configurada; esta tabla es lo que hace que el
-- mismo comando también llegue por long-poll si Ably no entregó (o no está
-- configurada), y lo que le da id estable a cada comando para el dedupe
-- cliente-side entre las dos vías (ver useDeviceSync.ts).
create table if not exists playback_commands (
  id         text primary key,  -- generado en el backend, ver generateRandomToken()
  user_id    uuid not null references users(id) on delete cascade,
  device_key text not null,     -- destino: devices.device_key — sin FK a propósito, la fila puede sobrevivir a un revoke
  type       text not null,
  payload    jsonb,
  created_at timestamptz not null default now()
);
create index if not exists playback_commands_target_idx on playback_commands(user_id, device_key, created_at);

-- Limpieza periódica opcional: sesiones vencidas, challenges vencidos y
-- buckets de rate-limit viejos (no es obligatorio correrlo, la app funciona
-- igual sin esto, es solo housekeeping — considerar sumarlo al cron de
-- r2-lifecycle).
-- delete from sessions where expires_at < now();
-- delete from auth_challenges where expires_at < now();
-- delete from rate_limits where reset_at < now() - interval '1 day';

-- ============================================================================
-- MIGRACIÓN — seguridad tipo Discord (passkeys + 2FA TOTP + sesiones con
-- metadata). Correr esto UNA vez si tu DB ya tenía las tablas de arriba
-- creadas ANTES de este cambio. Es seguro correrlo más de una vez.
-- ============================================================================
-- alter table users add column if not exists totp_secret text;
-- alter table users add column if not exists totp_enabled boolean not null default false;
-- alter table users add column if not exists backup_codes jsonb not null default '[]'::jsonb;
-- alter table sessions add column if not exists device_name text;
-- alter table sessions add column if not exists user_agent text;
-- alter table sessions add column if not exists ip text;
-- alter table sessions add column if not exists last_seen_at timestamptz not null default now();
-- create table if not exists webauthn_credentials (
--   id           text primary key,
--   user_id      uuid not null references users(id) on delete cascade,
--   public_key   text not null,
--   counter      bigint not null default 0,
--   transports   jsonb not null default '[]'::jsonb,
--   device_name  text not null default 'Passkey',
--   created_at   timestamptz not null default now(),
--   last_used_at timestamptz
-- );
-- create index if not exists webauthn_credentials_user_id_idx on webauthn_credentials(user_id);
-- create table if not exists auth_challenges (
--   id         text primary key,
--   user_id    uuid references users(id) on delete cascade,
--   type       text not null,
--   challenge  text not null default '',
--   created_at timestamptz not null default now(),
--   expires_at timestamptz not null default now() + interval '5 minutes'
-- );
-- create index if not exists auth_challenges_expires_idx on auth_challenges(expires_at);

-- ============================================================================
-- MIGRACIÓN — correr esto UNA vez si tu DB ya existía antes de este cambio
-- (`create table if not exists` de arriba no toca tablas que ya tienen filas
-- con otras columnas). Es seguro correrlo más de una vez.
-- ============================================================================
-- alter table sessions add column if not exists expires_at timestamptz not null default now() + interval '30 days';
-- create index if not exists sessions_expires_at_idx on sessions(expires_at);
-- update sessions set expires_at = created_at + interval '30 days' where expires_at is null;
-- create table if not exists rate_limits (
--   key      text primary key,
--   count    integer not null default 1,
--   reset_at timestamptz not null
-- );

-- ============================================================================
-- MIGRACIÓN — sistema de dispositivos (Spotify Connect). Correr esto UNA vez
-- si tu DB ya tenía las tablas de arriba creadas ANTES de este cambio (y no
-- tenía `devices`/`playback_commands` de una versión incompatible — ver la
-- nota al principio del archivo). Es seguro correrlo más de una vez.
-- ============================================================================
-- create table if not exists devices (
--   id           uuid primary key default gen_random_uuid(),
--   user_id      uuid not null references users(id) on delete cascade,
--   device_key   text not null,
--   session_id   uuid references sessions(id) on delete set null,
--   name         text not null,
--   name_custom  boolean not null default false,
--   kind         text not null default 'web',
--   is_active    boolean not null default false,
--   player_state jsonb,
--   last_seen_at timestamptz not null default now(),
--   created_at   timestamptz not null default now(),
--   unique (user_id, device_key)
-- );
-- create index if not exists devices_user_id_idx on devices(user_id, last_seen_at desc);
-- create table if not exists playback_commands (
--   id         text primary key,
--   user_id    uuid not null references users(id) on delete cascade,
--   device_key text not null,
--   type       text not null,
--   payload    jsonb,
--   created_at timestamptz not null default now()
-- );
-- create index if not exists playback_commands_target_idx on playback_commands(user_id, device_key, created_at);
