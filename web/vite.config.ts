import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
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
