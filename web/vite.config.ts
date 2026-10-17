import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
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
  plugins: [react(), tailwindcss()],
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
