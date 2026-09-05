// PlaylistsPage y PlaylistDetailPage NO se re-exportan: son rutas lazy
// (ver nota en features/player/index.js) — App.jsx eager-importa
// usePlaylistsStore de este barrel, y eso arrastraría esas páginas.
export { default as AddToPlaylistButton } from './components/AddToPlaylistButton'
export { usePlaylistsStore } from './store/usePlaylistsStore'
