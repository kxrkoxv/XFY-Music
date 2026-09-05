/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import type { ProxyOptions, Plugin, ViteDevServer } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Red de seguridad para desarrollo local: en pruebas, cuando la red hacia
// music.youtube.com está bloqueada/filtrada (ej. detección de bots de
// Google contra la IP), `ytmusic-api` puede disparar un rechazo de
// promesa no controlado en un punto interno de la librería que ningún
// try/catch nuestro llega a atajar — y desde Node 15+ eso tira abajo el
// proceso entero por default. Esto evita que un solo request roto mate
// el servidor de `vite dev`; en producción cada invocación de la Vercel
// Function ya es aislada, así que el radio de impacto de lo mismo ahí es
// mucho menor (falla ese request, no arrastra a los demás).
process.on('unhandledRejection', (err) => {
  console.error('[dev] Rechazo de promesa no controlado (no se cae el servidor):', err instanceof Error ? err.message : err)
})
process.on('uncaughtException', (err) => {
  console.error('[dev] Excepción no controlada (no se cae el servidor):', err instanceof Error ? err.message : err)
})

const simpleProxy = (target: string, from: string, to = ''): ProxyOptions => ({
  target,
  changeOrigin: true,
  rewrite: (urlPath) => urlPath.replace(new RegExp(`^${from}`), to),
})

interface MockResponseState {
  code: number
  headers: Record<string, string>
  body: string | Buffer | null
  ended: boolean
}

/** Shape mínimo de VercelResponse que los handlers de api/ usan en dev. */
type MockVercelResponse = Record<string, unknown>

// Plugin de desarrollo: ejecuta las VERDADERAS Vercel Functions de api/
// dentro del server de Vite, así `vite dev` se comporta idéntico a
// producción (misma lógica, mismo caché, mismos errores). Antes cada
// endpoint tenía su propia reimplementación acá adentro — con el tiempo
// las copias divergieron de la Function real (thumbnails sin upscale,
// artista sin description) y los bugs solo se veían en producción.
//
// Los endpoints ya son .ts: Node 24+ los ejecuta directo vía type
// stripping nativo (mismo runtime que `vite dev`), y Vercel los compila
// con @vercel/node en producción.
function vercelFunctionsDevPlugin(): Plugin {
  return {
    name: 'vercel-functions-dev',
    configureServer(server: ViteDevServer) {
      // Mock req/res suficientemente completo para ejecutar las Vercel
      // Functions reales dentro del server de Vite: soporta setHeader,
      // status().json() y end() (con Buffer para imgproxy).
      const mocksFor = (
        urlObj: URL,
        nodeRes: ServerResponse,
      ): { mockReq: MockVercelResponse; mockRes: MockVercelResponse } => {
        const state: MockResponseState = { code: 200, headers: {}, body: null, ended: false }
        const flush = (): void => {
          if (state.ended || nodeRes.writableEnded) return
          state.ended = true
          nodeRes.statusCode = state.code
          for (const [k, v] of Object.entries(state.headers)) nodeRes.setHeader(k, v)
          if (!nodeRes.getHeader('Content-Type')) nodeRes.setHeader('Content-Type', 'application/json')
          nodeRes.end(state.body ?? '')
        }
        const mockRes: MockVercelResponse = {
          setHeader: (k: string, v: string) => { state.headers[k] = v },
          status(code: number) {
            state.code = code
            return {
              json: (data: unknown) => { state.body = JSON.stringify(data); flush() },
              end: (payload?: string | Buffer | null) => {
                if (payload !== undefined && payload !== null) state.body = payload
                else if (state.body == null) state.body = ''
                flush()
              },
            }
          },
          json: (data: unknown) => { state.body = JSON.stringify(data); flush() },
          end: (payload?: string | Buffer | null) => {
            if (payload !== undefined && payload !== null) state.body = payload
            else if (state.body == null) state.body = ''
            flush()
          },
        }
        const mockReq: MockVercelResponse = { query: Object.fromEntries(urlObj.searchParams.entries()) }
        return { mockReq, mockRes }
      }

      type VercelHandler = (req: unknown, res: unknown) => Promise<unknown>

      const runFunction = async (
        modulePath: string,
        urlObj: URL,
        nodeRes: ServerResponse,
        extraReq: MockVercelResponse = {},
      ): Promise<void> => {
        // OJO: import dinámico relativo ('./api/x.ts') NO sirve acá — Vite
        // transpila este config a node_modules/.vite-temp/ y el módulo se
        // resolvería contra ESA carpeta (ERR_MODULE_NOT_FOUND disfrazado de
        // 500 en el middleware). Anclar siempre a la raíz real del proyecto.
        const mod = (await import(pathToFileURL(join(server.config.root, modulePath)).href)) as {
          default: VercelHandler
        }
        const { mockReq, mockRes } = mocksFor(urlObj, nodeRes)
        await mod.default({ ...mockReq, ...extraReq }, mockRes)
      }

      // Lee y parsea el body JSON de un request POST crudo de Node (Vite
      // dev server no lo hace automáticamente, a diferencia de Vercel).
      const readJsonBody = (req: IncomingMessage): Promise<Record<string, unknown>> =>
        new Promise((resolve) => {
          let raw = ''
          req.on('data', (chunk: Buffer) => { raw += chunk.toString() })
          req.on('end', () => {
            try {
              resolve(raw ? (JSON.parse(raw) as Record<string, unknown>) : {})
            } catch {
              resolve({})
            }
          })
          req.on('error', () => resolve({}))
        })

      server.middlewares.use(async (req, res, next) => {
        const FUNCTION_PREFIXES = ['/api/ytmusic', '/api/motionart', '/api/musicbrainz', '/api/imgproxy', '/api/ytcache', '/api/push', '/api/spotify']
        if (!req.url || !FUNCTION_PREFIXES.some((p) => req.url?.startsWith(p))) return next()

        const url = new URL(req.url, 'http://localhost')
        const send = (code: number, data: unknown): void => {
          res.statusCode = code
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify(data))
        }

        try {
          // Caché de audio (extracción + upload a Vercel Blob). El body
          // JSON del POST se parsea acá porque el server de Vite no lo
          // hace solo; requiere BLOB_READ_WRITE_TOKEN en el .env local
          // para funcionar de punta a punta, pero corre igual sin él
          // (la Function responde lo que corresponda, 405 incluido).
          if (url.pathname.startsWith('/api/ytcache')) {
            const body = req.method === 'POST' ? await readJsonBody(req) : {}
            await runFunction('./api/ytcache.ts', url, res, { method: req.method || 'GET', body })
            return
          }

          // Push (subscribe/state/unsubscribe por op en el body): misma
          // historia del body — se parsea acá y la Function real decide.
          if (url.pathname.startsWith('/api/push')) {
            const body = req.method === 'POST' ? await readJsonBody(req) : {}
            await runFunction('./api/push.ts', url, res, { method: req.method || 'GET', body })
            return
          }

          // Todas las demás Functions corren igual que en producción.
          // Nota: musicbrainz necesita SU Function (no un proxy crudo):
          // ?resource= es un esquema propio y MusicBrainz exige User-Agent;
          // imgproxy resuelve CORS/mixed-content de CoverArtArchive.
          if (url.pathname.startsWith('/api/ytmusic')) {
            await runFunction('./api/ytmusic.ts', url, res)
          } else if (url.pathname.startsWith('/api/motionart')) {
            await runFunction('./api/motionart.ts', url, res)
          } else if (url.pathname.startsWith('/api/musicbrainz')) {
            // proxyutils.ts dispatchea por ?kind= — se lo inyectamos acá
            // porque la ruta vieja /api/musicbrainz no lo manda.
            await runFunction('./api/proxyutils.ts', url, res, { query: { ...Object.fromEntries(url.searchParams.entries()), kind: 'musicbrainz' } })
          } else if (url.pathname.startsWith('/api/imgproxy')) {
            await runFunction('./api/proxyutils.ts', url, res, { query: { ...Object.fromEntries(url.searchParams.entries()), kind: 'img' } })
          } else if (url.pathname.startsWith('/api/spotify')) {
            const body = req.method === 'POST' ? await readJsonBody(req) : {}
            await runFunction('./api/spotify.ts', url, res, { method: req.method || 'GET', body, headers: req.headers })
          }
        } catch (e) {
          send(500, { error: e instanceof Error ? e.message : String(e) })
        }
      })
    },
  }
}

export default defineConfig({
  plugins: [
    react(),
    vercelFunctionsDevPlugin(),
    // PWA: estrategia injectManifest — el SW vive en src/sw.ts (misma
    // lógica que tenía el sw.js manual) y el plugin le inyecta en build
    // la lista completa de assets del dist (self.__WB_MANIFEST), así el
    // shell offline ya no depende de una lista hardcoded. El manifest de
    // la app sigue siendo public/manifest.webmanifest (fuente única,
    // manifest:false acá) y el registro lo hace PwaRegistration a mano
    // (injectRegister:false) porque maneja el flujo "toast de actualización".
    VitePWA({
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      registerType: 'prompt',
      injectRegister: false,
      manifest: false,
      injectManifest: {
        // El SW compilado debe llamarse sw.js (misma URL que registraba el
        // sw manual — las PWA ya instaladas siguen encontrándolo).
        // injectionPoint: workbox reemplaza esta EXPRESIÓN COMPLETA por el
        // array de entradas del dist. `globalThis.__WB_MANIFEST` sobrevive
        // la minificación (un alias local sería renombrado y el match del
        // string fallaría); ver comentario en src/sw.ts.
        injectionPoint: 'globalThis.__WB_MANIFEST',
        globPatterns: ['**/*.{js,css,html,png,svg,ico,webmanifest,woff2}'],
        maximumFileSizeToCacheInBytes: 3 * 1024 * 1024,
      },
      devOptions: { enabled: false },
    }),
  ],
  resolve: {
    // Alias absolutos en vez de imports relativos (../../../lib/x). Un solo
    // punto de entrada por capa: @ para todo src/, y uno por capa arquitectónica
    // (features, shared, services).
    alias: {
      '@': path.resolve(__dirname, 'src'),
      '@features': path.resolve(__dirname, 'src/features'),
      '@shared': path.resolve(__dirname, 'src/shared'),
      '@services': path.resolve(__dirname, 'src/services'),
    },
  },
  build: {
    // El warning de Vite es sobre el tamaño SIN comprimir. En vez de solo
    // subir el límite, separamos el vendor code (React, Motion, Router,
    // Zustand, Sonner, lucide-react, etc.) del código propio en chunks
    // dedicados vía codeSplitting. Así el navegador puede cachear el vendor
    // chunk por separado (cambia mucho menos seguido que nuestro código) y
    // ningún chunk individual pasa de ~1600kb sin comprimir.
    chunkSizeWarningLimit: 1600,
    // codeSplitting (API nativa de rolldown; antes advancedChunks) en vez
    // de manualChunks: el compat de manualChunks ignora módulos con menos
    // de 2 referencias (minShareCount default), lo que dejaba al monolito
    // de @animateicons — referenciado UNA sola vez vía dynamic import —
    // sin su grupo y fusionado donde mejor cayera. Acá cada grupo controla
    // su propio minShareCount.
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            { name: 'vendor-react', test: /[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/ },
            { name: 'vendor-router', test: /[\\/]react-router(-dom)?[\\/]/ },
            { name: 'vendor-motion', test: /[\\/]node_modules[\\/]motion[\\/]/ },
            // UI global (MiniPlayerBar) → eager, chunk propio chico.
            { name: 'vendor-morphicons', test: /[\\/]morphicons[\\/]/ },
            // Monolito de ~500 kB sin tree-shaking (un solo módulo con
            // todos los iconos animados adentro). Su único acceso es el
            // dynamic import de HeroGreeting; con minShareCount: 1 obtiene
            // SU chunk y queda diferido — no viaja en la carga inicial.
            { name: 'vendor-animateicons', test: /[\\/]@animateicons[\\/]/, minShareCount: 1 },
            { name: 'vendor-misc', test: /[\\/]node_modules[\\/](zustand|sonner|@base-ui|@kawarp|cubic-spline)[\\/]/ },
            // Chunk chico (~11 kB): los imports nombrados tree-shakean bien
            // SIEMPRE QUE el paquete esté instalado sano. Con node_modules
            // corrupto (entry ESM faltante), rolldown caía al CJS monolítico
            // y metía los ~1776 iconos completos (+470 kB). Si este chunk
            // vuelve a engordar de golpe: reinstalar lucide-react.
            { name: 'vendor-lucide', test: /[\\/]node_modules[\\/]lucide-react[\\/]/ },
          ],
        },
      },
    },
  },
  server: {
    // clientPort fuerza al socket a conectar directo a Vite para mantener el HMR estable.
    port: 5173,
    strictPort: true,
    hmr: {
      clientPort: 5173,
    },
    proxy: {
      '/api/itunes': simpleProxy('https://itunes.apple.com', '/api/itunes'),
      '/api/apple-charts': simpleProxy('https://rss.marketingtools.apple.com', '/api/apple-charts'),
      '/api/audiodb': simpleProxy('https://www.theaudiodb.com', '/api/audiodb', '/api/v1/json/123'),
      '/api/lrclib': simpleProxy('https://lrclib.net', '/api/lrclib', '/api'),
      // /api/musicbrainz NO va acá: ?resource= es un esquema de la Vercel
      // Function, el middleware de arriba ejecuta esa Function directamente.
      '/api/deezer': simpleProxy('https://api.deezer.com', '/api/deezer'),
      '/api/coverart': simpleProxy('https://coverartarchive.org', '/api/coverart'),
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
  },
})
