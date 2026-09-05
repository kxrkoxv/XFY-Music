// ============================================================
// Capa de servicios — un único punto de entrada para toda la
// integración con APIs externas del catálogo. Nadie fuera de
// services/api/ debería hacer fetch() directo a una API de terceros:
// si necesitás un dato nuevo, se agrega o extiende un proveedor acá,
// no se hace un cliente ad-hoc en el componente/página que lo usa.
// Eso es lo que causaba duplicados como el viejo lib/audius.js.
//
// Import recomendado: import { ytmusic, itunes } from '@services/api'
// (o el módulo suelto: import { searchSongs } from '@services/api/ytmusic')
// ============================================================
export * as appleCharts from './appleCharts'
export * as appleClient from './appleClient'
export * as audiodb from './audiodb'
export * as deezer from './deezer'
export * as itunes from './itunes'
export * as musicbrainz from './musicbrainz'
export * as wikipedia from './wikipedia'
export * as ytPlaylist from './ytPlaylist'
export * as ytmusic from './ytmusic'
