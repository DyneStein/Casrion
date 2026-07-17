import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  // Relative base so the packaged app can load assets from file:// inside app.asar
  base: './',
  plugins: [react()],
})
