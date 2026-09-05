# Spicy Lyrics → XFY

Integración del motor visual de Spicy Lyrics en el reproductor XFY.

## Contexto

Spicy Lyrics es una extensión de Spicetify que solo funciona dentro del cliente de escritorio de Spotify (depende de `window.Spicetify.Player`, `Platform`, y de endpoints internos de Spotify para búsqueda y parseo de letras). Nada de eso es reusable fuera de ahí.

Lo que SÍ se portó es el motor visual real, independizado de Spicetify:

## Tema adaptativo

`engine/extractPalette.ts` + `engine/useAdaptiveTheme.ts`: extraen el color dominante "vivo" (ni gris, ni casi negro/blanco) de la portada — y, si la canción tiene video de fondo, resamplean el frame actual cada 4s para que el acento siga la escena — y sobreescriben `--accent`, `--accent-strong`, `--accent-glow`, `--accent-dim` **solo dentro de `.player-page`** (inline style en el contenedor). El resto de la app sigue con el morado fijo de `tokens.css`.

Como todo lo que ya usaba `var(--accent-glow)` (letras activas, break dots, glow del texto, tinte de `DynamicBackground`) lee esas variables por cascada, no hubo que tocar ninguna otra regla CSS — solo agregar el override en el punto de entrada.

La transición de color es suave gracias a `@property` (con fallback transparente en navegadores sin soporte: cambia sin transición, nunca rompe).

No hay dependencias nuevas — la extracción es un cuantizador propio, sin librería, sobre un canvas de 48×48.

## Fuente de letras

`lrclib.ts`: reemplaza al backend local (`localhost:4001`) como fuente principal. Antes, un solo intento contra el proxy casero fallaba silenciosamente para varias canciones. Ahora se llama **directo** a [LRCLIB](https://lrclib.net/docs) (pública, gratuita, sin API key, con CORS habilitado — se puede pegar desde el navegador sin backend propio) con una cadena de intentos:

1. `/api/get` con `duration` exacta (más preciso, si se tiene)
2. si falla → `/api/search`, elige el mejor candidato (prioriza letra sincronizada, duración más cercana, coincidencia de título/artista)
3. si el mejor candidato solo tiene letra **plana** (sin timing por línea), se usa igual repartiendo el tiempo parejo — mejor letra completa sin sync perfecto que nada
4. 1 reintento automático ante error de red (no ante "no encontrado")
5. resultado cacheado en `sessionStorage` por canción — no vuelve a pedir lo mismo dos veces
6. si TODO lo anterior falla, se queda con `song.lyrics` (lo que ya se tenía) como último recurso — nunca se queda sin letra por un fallo

`LyricsPanel` muestra un aviso sutil ("Letra sin sincronización exacta") cuando la letra vino sin timing real, para que se sepa que ese caso puntual es aproximado.

Nota: los navegadores no dejan setear el header `User-Agent`; LRCLIB documenta `Lrclib-Client`/`X-User-Agent` como alternativa para clientes web, que es lo que se usa acá.

## Qué es nuevo

- **`modules/Spring.ts` / `Scheduler.ts` / `Maid.ts`** — copia 1:1 de los módulos base de Spicy Lyrics (son standalone, sin ninguna dependencia de Spicetify). `Spring.ts` es el simulador de resorte físico (port de [Fraktality/spr](https://github.com/Fraktality/spr)) que le da a cada palabra su "rebote" característico en vez de un fade lineal.

- **`engine/curves.ts`** — las mismas curvas de animación (escala, glow, offset vertical) que usa `LyricsAnimator.ts` en el original, portadas con la librería `cubic-spline` (la misma que usa Spicy Lyrics).

- **`engine/useKaraokeWords.ts`** — el hook que conecta las curvas + resortes al DOM, frame a frame, sin pasar por `useState` (mismo criterio de performance que ya existía en `LyricsPanel`: nada que cambie varias veces por segundo debe forzar un re-render de React).

- **`components/KaraokeLine.tsx`** — reemplaza a `LyricLine` SOLO para la línea activa: la desglosa palabra por palabra con la animación de arriba. El resto de las líneas siguen usando `LyricLine` de siempre (gradiente por línea) — nunca hay más de una `KaraokeLine` montada.

- **`components/DynamicBackground.tsx`** — el fondo animado tipo Apple Music/Spicy Lyrics (portada difuminada + distorsión orgánica en movimiento), usando `@kawarp/core`: es la MISMA librería standalone (MIT, cero dependencias) que usa `dynamicBackground.ts` en la extensión original. Ahí ese archivo son ~500 líneas de plomería específica de Spotify (rasterizar covers `spotify:local:`, fondos de artista) *alrededor* de esta librería — como las portadas ya son URLs normales, no se necesitó nada de eso.

- **`wordTiming.ts`** — fallback cuando NO hay timing real por palabra: reparte la duración de la línea entre sus palabras, proporcional a su longitud (mismo truco que usa Musixmatch en modo "estimado"). Solo se usa cuando la línea no trae datos exactos.

- **`lrclib.ts` ahora también parsea "Enhanced LRC"** (`<mm:ss.xx>` por palabra dentro de la línea — la extensión A2 que usan Musixmatch y parte de la base de LRCLIB) y expone `words` con timing real por línea cuando está disponible. `KaraokeLine` usa ese `words` real tal cual y solo cae a `wordTiming.ts` cuando la fuente no lo trae — es la sincronización exacta palabra por palabra cuando LRCLIB la tiene, y el reparto estimado como red de seguridad cuando no.

- **`parseTTML.ts`** — parser de TTML standalone (nuevo, no existía nada reusable en el original — ahí se lo mandan a un endpoint de Spotify). No se usa todavía. El día que se consigan letras con timing real por palabra (archivos `.ttml`, bases tipo Musixmatch-syncedlyrics), esta función da el mismo shape `{ text, start, end, words }` para reemplazar a `wordTiming.ts` sin tocar `KaraokeLine`.

## Qué NO se portó (y por qué)

Todo esto es *chrome* de la extensión — interfaz específica del cliente de Spotify, no del sistema de letras en sí:

- Settings panel, modo compacto, picture-in-picture, fullscreen overlay de Spicetify — conceptos que no existen en una app web standalone.
- El gestor de letras (buscar/subir TTML, base de datos IndexedDB de letras) — es una UI de administración de la extensión, no el motor visual que se pidió.
- "Artist Visuals" (fotos de artista de fondo) — depende de la API interna de Spotify para biografías/fotos de artista.
- Romanización (japonés/coreano/cirílico), análisis de idioma — son librerías pesadas (`kuroshiro`, `franc-all`, `cyrillic-romanization`) orientadas a un catálogo multi-idioma; agréguense después si se necesitan, no tiene sentido en el primer paso.

## Cómo se integró

- `LyricsPanel.tsx`: la línea activa ahora renderiza `<KaraokeLine>` en vez de `<LyricLine>` (el resto de líneas no cambia).
- `PlayerPage.tsx`: `<DynamicBackground>` se monta detrás del contenido, **solo cuando la canción no tiene `videoBgSrc` propio** (si ya hay video, el fondo animado quedaría tapado — no tiene sentido pagar el costo de WebGL para nada).
- Paleta: el tinte del fondo usa tu `--accent` morado (`#8b5cf6`), no el rojo/negro de Spicy Lyrics original.

## Dependencias nuevas

```json
"@kawarp/core": "^1.2.0",   // fondo animado (WebGL warp/blur)
"cubic-spline": "^3.0.3"    // curvas de animación por palabra
```

Ya están en `package.json` y compilan limpio (`npm run build` — probado). `d3-ease` se sacó porque no terminó usándose.

## Variantes de escritorio (modo PC)

En escritorio (detectado por `useCanHover` = hover + puntero fino) el panel de letras cambia a una variante "desktop" (`.lyrics-panel--desktop`):

- Tipografía más grande (1.45rem, peso 800) alineada a la IZQUIERDA (en móvil sigue centrada).
- Escalera de indentación horizontal por distancia a la línea activa (12px por paso, espejada en dúos).
- Pops de palabra amplificados (`--pop-y: 1.3`, `--pop-s: 1.45`).
- Glow más fuerte en la activa, fade de bordes más profundo.
- Feedback de hover en líneas inactivas (brillo + `translate: 0 1px` al click).
- Modo cinema conserva SU escala tipográfica y ritmo vertical propios; el resto de la variante desktop (alineado, escalera, pops) sí aplica en cinema a propósito: pantalla completa de letras = el look Spicetify llevado al extremo.
- Todo respeta `prefers-reduced-motion`.

La clase la pone `LyricsPanel` solo con hover real + puntero fino (`useCanHover`) — en táctil no cambia nada (multiplicadores defaultean a 1).

## Animaciones smooth del sistema de letras

- **Interpolación de relleno/glow**: registraron `--word-fill` y `--word-glow` con `@property` (con `inherits: true`, crítico porque el motor escribe la prop en el span exterior y la lee el hijo con el degradado) + transición de 90ms — el barrido del karaoke ahora se desliza en vez de saltar entre frames (más notorio tras un seek).
- **Cascada de entrada**: al activarse una línea, cada palabra entra escalonada desde abajo (`opacity` + `translate` individual, que se compone con el `transform` del resorte sin pisarlo), con delay proporcional a su posición (`--wi`, tope 420ms) y replay automático en cada activación.
- **Asentamiento con inercia**: transición de palabra a reposo subida a 340ms quint-out; brillo extra en la palabra que suena ahora (`.word-active`).