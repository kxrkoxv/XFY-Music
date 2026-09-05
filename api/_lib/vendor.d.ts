// Declaraciones ambientales para paquetes sin tipos propios, usados solo
// por las Vercel Functions (este archivo lo incluye tsconfig.node.json).

declare module 'jsdom' {
  export interface JSDOMWindow {
    document: unknown
    location: { href: string; origin: string }
    origin: string
    navigator: unknown
    [key: string]: unknown
  }

  export interface JSDOMOptions {
    url?: string
    referrer?: string
    userAgent?: string
    [key: string]: unknown
  }

  export class JSDOM {
    constructor(html?: string, options?: JSDOMOptions)
    window: JSDOMWindow
  }
}
