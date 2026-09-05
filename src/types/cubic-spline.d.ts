// Declaración ambient para cubic-spline — paquete sin tipos propios.
// Solo se usa en el motor de letras (curvas de easing del karaoke).
declare module 'cubic-spline' {
  export default class CubicSpline {
    constructor(xs: number[], ys: number[])
    at(x: number): number
  }
}
