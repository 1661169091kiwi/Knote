import { createApp } from 'vue'
import '@fontsource-variable/cinzel/wght.css'
import './style.css'
import './cursors.css'
import './resize-controls.css'
// Glass theme (themes "glass" / "glass-dark"): inert unless <html class="gl">
import './glass/glass.css'
import './glass/knote-glass.css'
import './glass/glass.js'
import App from './App.vue'

// The liquid-glass bend only runs while the Glass theme is on.
if (window.LiquidGlass) window.LiquidGlass.enabled = () => document.documentElement.classList.contains('gl')

// surface boot/setup errors so the smoke probe can read them (dist only)
window.addEventListener('error', (e) => { window.__knoteBootError = String(e.message || e.error) })
try {
  const app = createApp(App)
  app.config.errorHandler = (err) => { window.__knoteBootError = String((err && err.stack) || err) }
  app.mount('#app')
} catch (err) {
  window.__knoteBootError = String((err && err.stack) || err)
  throw err
}
