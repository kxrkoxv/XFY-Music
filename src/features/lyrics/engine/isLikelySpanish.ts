// Heurística liviana (sin librería de detección de idioma pesada) para
// decidir si vale la pena ofrecer el botón de traducción: cuenta palabras
// funcionales muy comunes en español vs. en otros idiomas frecuentes en
// letras (inglés, portugués, italiano, francés) sobre una muestra del
// texto. No pretende ser un detector de idioma real — solo evitar el caso
// obvio de "traducir" una canción que ya está en español.

const SPANISH_MARKERS = new Set([
  'de', 'que', 'y', 'la', 'el', 'en', 'un', 'una', 'los', 'las', 'no', 'te',
  'me', 'se', 'mi', 'tu', 'su', 'por', 'con', 'para', 'como', 'más', 'pero',
  'porque', 'yo', 'tú', 'él', 'ella', 'nosotros', 'esto', 'eso', 'aquí',
  'ahora', 'siempre', 'nunca', 'quiero', 'eres', 'estoy', 'está', 'vida',
])

const OTHER_LANG_MARKERS = new Set([
  // Inglés
  'the', 'and', 'you', 'your', 'love', 'like', 'know', 'don', 'this', 'that',
  'with', 'for', 'are', 'was', 'have', 'just', 'get', 'got', 'baby', 'yeah',
  // Portugués
  'não', 'você', 'para', 'com', 'uma', 'ele', 'ela', 'coração', 'saudade',
  // Italiano / Francés (marcadores poco ambiguos con español)
  'perché', 'sono', 'della', 'ainsi', 'avec', 'être', 'nous', 'vous',
])

/** Analiza hasta las primeras `sampleLines` líneas para no tener que leer la letra entera. */
export function isLikelySpanish(lines: string[], sampleLines = 12): boolean {
  const sample = lines.slice(0, sampleLines).join(' ').toLowerCase()
  const words = sample.match(/[\p{L}'’]+/gu) || []
  if (words.length === 0) return false

  let spanishHits = 0
  let otherHits = 0
  for (const w of words) {
    if (SPANISH_MARKERS.has(w)) spanishHits++
    else if (OTHER_LANG_MARKERS.has(w)) otherHits++
  }

  // Sin señales claras (letra muy corta, instrumental parcial, etc.): se
  // asume que NO es español para no esconder el botón sin evidencia.
  if (spanishHits === 0 && otherHits === 0) return false
  return spanishHits > otherHits
}
