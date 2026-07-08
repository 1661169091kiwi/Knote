import { createApp } from 'vue'
import './style.css'
import App from './App.vue'

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
