import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig({
  // relative asset paths: the Electron shell loads dist/index.html from
  // file://, where absolute /assets/... URLs would break
  base: './',
  plugins: [
    vue(),
    tailwindcss(),
  ],
})
