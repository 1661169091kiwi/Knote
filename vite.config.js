import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'
// rewrites DaisyUI's dropdown focus rule, whose [class*=] :has() made every
// class change restyle the whole document (see the module)
import { daisyDropdownFocus } from './vite/daisy-dropdown-focus.js'

// https://vite.dev/config/
export default defineConfig({
  // relative asset paths: the Electron shell loads dist/index.html from
  // file://, where absolute /assets/... URLs would break
  base: './',
  plugins: [
    vue(),
    tailwindcss(),
    daisyDropdownFocus(),
  ],
  build: { rollupOptions: { input: { app: 'index.html', print: 'print.html' } } },
})
