import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: '../../web-dist',
    emptyOutDir: true,
  },
  server: {
    proxy: {
      '/api': 'http://localhost:8880',
      '/hooks': 'http://localhost:8880',
      '/ws': {
        target: 'ws://localhost:8880',
        ws: true,
      },
    },
  },
})
