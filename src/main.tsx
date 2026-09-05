import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles/tokens.css'
import './styles/global.css'
import './styles/scrollbars.css'
import App, { SpotifyCallbackScreen } from './App'

// Spotify solo puede redirigir a un path real registrado tal cual en su
// dashboard (ej. https://tu-dominio/spotify-callback) — no a una ruta
// con hash. Por eso esta pantalla se decide ACÁ, antes de montar
// <App/> (y su HashRouter), en vez de ser una <Route/> más.
const isSpotifyCallback = window.location.pathname === '/spotify-callback'

createRoot(document.getElementById('root')!).render(
  <StrictMode>{isSpotifyCallback ? <SpotifyCallbackScreen /> : <App />}</StrictMode>,
)
