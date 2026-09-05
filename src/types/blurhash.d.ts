// Type declarations for blurhash (no official @types package)
declare module 'blurhash' {
  export function encode(
    pixels: Uint8ClampedArray,
    width: number,
    height: number,
    componentsX: number,
    componentsY: number
  ): string

  export function decode(
    hash: string,
    width: number,
    height: number,
    punch?: number
  ): Uint8ClampedArray

  export function isValid(hash: string): boolean
}