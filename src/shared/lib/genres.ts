/**
 * Traducción de géneros musicales a español. AudioDB/MusicBrainz devuelven
 * los géneros en inglés (a veces mezclados con español, sin consistencia),
 * así que sin esto la tarjeta de artista mostraba "Electronic", "Hip-Hop",
 * "Latin" tal cual venían de la fuente en vez de un género coherente.
 * No es una lista exhaustiva — cualquier género no listado se muestra tal
 * cual llegó, capitalizado, en vez de quedar vacío.
 */
export const GENRE_LABELS_ES = {
  pop: 'Pop',
  rock: 'Rock',
  'hip-hop': 'Hip-Hop',
  'hip hop': 'Hip-Hop',
  rap: 'Rap',
  'r&b': 'R&B',
  rnb: 'R&B',
  soul: 'Soul',
  electronic: 'Electrónica',
  electronica: 'Electrónica',
  edm: 'Electrónica',
  dance: 'Dance',
  house: 'House',
  techno: 'Techno',
  latin: 'Latino',
  latino: 'Latino',
  reggaeton: 'Reggaetón',
  'reggaeton flow': 'Reggaetón',
  urbano: 'Urbano',
  urban: 'Urbano',
  trap: 'Trap',
  bachata: 'Bachata',
  salsa: 'Salsa',
  merengue: 'Merengue',
  cumbia: 'Cumbia',
  jazz: 'Jazz',
  blues: 'Blues',
  classical: 'Clásica',
  folk: 'Folk',
  country: 'Country',
  metal: 'Metal',
  punk: 'Punk',
  indie: 'Indie',
  alternative: 'Alternativo',
  'alternative rock': 'Rock alternativo',
  reggae: 'Reggae',
  ska: 'Ska',
  gospel: 'Gospel',
  religious: 'Religioso',
  world: 'Mundo',
  ambient: 'Ambient',
  instrumental: 'Instrumental',
  soundtrack: 'Banda sonora',
  children: 'Infantil',
  vocal: 'Vocal',
  'singer-songwriter': 'Cantautor',
  'singer/songwriter': 'Cantautor',
} satisfies Record<string, string>

/** Traduce (o al menos capitaliza) un género crudo de una fuente externa. */
export function translateGenre(raw: string | null | undefined): string | null {
  if (!raw) return null
  const key = String(raw).toLowerCase().trim()
  // `in` afina keyof del catálogo — con satisfies el objeto conserva sus
  // claves literales, así que el lookup tipado es gratis.
  if (key in GENRE_LABELS_ES) return GENRE_LABELS_ES[key as keyof typeof GENRE_LABELS_ES]
  // Sin traducción conocida: devolvemos el original con la primera letra
  // en mayúscula en vez de dejarlo vacío o inconsistente.
  return key.charAt(0).toUpperCase() + key.slice(1)
}
