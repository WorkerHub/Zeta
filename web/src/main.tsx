import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { setLocale } from './lib/translations'
import { getStoredLocale } from './lib/i18n'
import './index.css'

setLocale(getStoredLocale())

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
