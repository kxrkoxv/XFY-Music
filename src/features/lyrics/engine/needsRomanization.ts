// Detección de script no-latino para decidir cuándo tiene sentido ofrecer
// el botón de romanización (letra japonesa/china/coreana/rusa/griega/etc.
// escrita en su alfabeto original). Mismo criterio que isRtl.ts: barrido
// carácter por carácter salteando dígitos/espacios/puntuación, así un
// título con paréntesis o números no arruina la detección.
//
// Deliberadamente NO cubre árabe/hebreo/persa acá — esos ya tienen su
// propio manejo (RTL + fuente Vazirmatn en isRtl.ts) y para lectura RTL
// la romanización ayuda menos de lo que estorba visualmente. Si hace
// falta más adelante, sumar ArabicPersianRegex de isRtl.ts a los rangos.

const RANGE_TEST =
  /[\u3040-\u309F\u30A0-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uAC00-\uD7A3\u1100-\u11FF\u0400-\u04FF\u0370-\u03FF\u0E00-\u0E7F]/u

const NEUTRAL_CHARS = /[\d\s,.;:?!()[\]{}"'\\/<>@#$%^&*_=+\-¡¿…«»]/u

/** Analiza hasta las primeras `sampleLines` líneas — igual criterio que isLikelySpanish. */
export function needsRomanization(lines: string[], sampleLines = 12): boolean {
  const sample = lines.slice(0, sampleLines).join(' ')
  for (const char of sample) {
    if (NEUTRAL_CHARS.test(char)) continue
    if (RANGE_TEST.test(char)) return true
  }
  return false
}

export default needsRomanization
