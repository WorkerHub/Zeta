import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'
import { execSync } from 'node:child_process'
import pkg from './package.json'

// Shown on the About page: the nearest release tag (`v1.2.3`, or `v1.2.3-4-gabc1234` for commits
// after it), falling back to package.json when git or the tags are unavailable.
function appVersion(): string {
  try {
    return execSync('git describe --tags', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim()
  } catch {
    return `v${pkg.version}`
  }
}

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    // PWA shell: the plugin writes manifest.webmanifest + sw.js into the build output; the worker
    // serves both as plain static assets (no route change needed). Registration is manual (see
    // src/main.tsx) because the CSP is script-src 'self' and an injected inline script would be blocked.
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: null,
      devOptions: { enabled: false },
      // The icons are already covered by globPatterns below; letting the plugin add the manifest
      // icons as well would list each of them twice in the precache manifest.
      includeManifestIcons: false,
      manifest: {
        id: '/',
        name: 'Zeta',
        short_name: 'Zeta',
        description: 'Zeta – Query your Cloudflare D1 databases',
        lang: 'en',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        theme_color: '#211d1a',
        background_color: '#f7f5f2',
        icons: [
          { src: '/pwa/icon-192x192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: '/pwa/icon-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: '/pwa/maskable-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // Precache the build shell only: hashed JS/CSS, index.html, the icons and favicon.
        // manifest.webmanifest is added by the plugin itself.
        globPatterns: ['**/*.{js,css,html,svg,png,ico}'],
        // Must stay empty: a navigateFallback would register a NavigationRoute that shadows the
        // NetworkFirst navigation route below.
        navigateFallback: null,
        skipWaiting: true,
        clientsClaim: true,
        cleanupOutdatedCaches: true,
        inlineWorkboxRuntime: true,
        runtimeCaching: [
          // Login, queries and writes must never reach Cache Storage.
          { urlPattern: ({ url }) => url.pathname.startsWith('/api/'), handler: 'NetworkOnly' },
          // A navigation always tries the network first, so a returning user gets the shell the
          // server currently serves; offline it falls back to the precached shell of this build.
          {
            urlPattern: ({ request }) => request.mode === 'navigate',
            handler: 'NetworkFirst',
            options: {
              cacheName: 'zeta-shell',
              networkTimeoutSeconds: 4,
              expiration: { maxEntries: 4 },
              precacheFallback: { fallbackURL: '/index.html' },
            },
          },
          {
            urlPattern: /^https:\/\/fonts\.googleapis\.com\//,
            handler: 'StaleWhileRevalidate',
            options: { cacheName: 'google-fonts-stylesheets', expiration: { maxEntries: 4, maxAgeSeconds: 604800 } },
          },
          {
            urlPattern: /^https:\/\/fonts\.gstatic\.com\//,
            handler: 'StaleWhileRevalidate',
            options: {
              cacheName: 'google-fonts-webfonts',
              cacheableResponse: { statuses: [0, 200] },
              expiration: { maxEntries: 20, maxAgeSeconds: 31536000 },
            },
          },
        ],
      },
    }),
  ],
  define: {
    __APP_VERSION__: JSON.stringify(appVersion()),
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules')) {
            if (id.includes('/react/') || id.includes('/react-dom/') || id.includes('react-router-dom')) {
              return 'react-vendor'
            }
            if (id.includes('@codemirror') || id.includes('@uiw/react-codemirror') || id.includes('codemirror')) {
              return 'editor-vendor'
            }
            if (id.includes('lucide-react')) {
              return 'icons-vendor'
            }
            return 'vendor'
          }
        },
      },
    },
  },
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:8787',
        changeOrigin: true,
      },
    },
  },
})
