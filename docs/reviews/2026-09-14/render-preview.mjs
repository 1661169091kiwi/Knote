import { chromium } from 'playwright-core'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'

const dir = path.dirname(fileURLToPath(import.meta.url))
// One isolated, headless browser; natural close, no taskkill/WMI/app profile.
const browser = await chromium.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: true,
  args: ['--disable-extensions', '--no-first-run']
})
try {
  const page = await browser.newPage({ viewport: { width: 1080, height: 800 }, deviceScaleFactor: 1.5 })
  await page.goto(pathToFileURL(path.join(dir, 'sidebar-design.html')).href)
  await page.screenshot({ path: path.join(dir, 'sidebar-design.png'), fullPage: true })
  const check = async () => page.evaluate(() => ({
    viewport: innerWidth,
    horizontalOverflow: document.documentElement.scrollWidth > innerWidth,
    cards: [...document.querySelectorAll('#narrow-card > .card, #wide-card > .card')].map((el) => ({ width: el.clientWidth, height: el.clientHeight, overflow: el.scrollWidth > el.clientWidth })),
    clippedControls: [...document.querySelectorAll('.actions button')].filter((el) => el.scrollWidth > el.clientWidth).length
  }))
  console.log('desktop', JSON.stringify(await check()))
  await page.setViewportSize({ width: 390, height: 844 })
  console.log('mobile', JSON.stringify(await check()))
  await page.locator('#narrow-card .segment').nth(1).click()
  console.log('previewToggle', await page.locator('#narrow-card .segment').nth(1).getAttribute('aria-pressed'))
} finally {
  await browser.close()
}
