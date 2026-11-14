import React from 'react'
import ReactDOM from 'react-dom/client'
import { registerSW } from 'virtual:pwa-register'
import App from './App'
import { setLocale } from './lib/translations'
import { getStoredLocale } from './lib/i18n'
import './index.css'

setLocale(getStoredLocale())

// Service worker (autoUpdate): a new deployment installs, claims the clients and replaces the
// precached shell. Registered here rather than injected into index.html, because the CSP is
// script-src 'self' and an inline registration script would be blocked. A no-op in dev.
registerSW({ immediate: true })

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
