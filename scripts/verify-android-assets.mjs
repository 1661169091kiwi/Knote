// Verify that Capacitor's default launcher art was replaced with output
// derived from Knote's versioned Windows artwork.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const assetsRequire = createRequire(require.resolve('@capacitor/assets/package.json'))
const sharp = assetsRequire('sharp')

const sources = {
  icon: {
    path: 'assets/icon.png',
    sha256: 'df2876d6a2267f848a3669e6370e5da2e1a7167abc91d06ee1a266cbf2009c0b'
  },
  splash: {
    path: 'assets/splash.png',
    sha256: '2f7cbf60dd131b1a3546d8894907b473d4c888734282a04e54b77a0977380964'
  }
}

function sha256(data) {
  return createHash('sha256').update(data).digest('hex')
}

async function rawImageHash(input) {
  const { data, info } = await sharp(input).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  return `${info.width}x${info.height}:${sha256(data)}`
}

async function verifyLegacyLauncherIcon() {
  const width = 192
  const padding = 8
  const resized = await sharp(sources.icon.path).resize(width, width).toBuffer()
  const expected = await sharp(resized)
    .resize(width - padding * 2, width - padding * 2)
    .extend({
      top: padding,
      bottom: padding,
      left: padding,
      right: padding,
      background: { r: 0, g: 0, b: 0, alpha: 0 }
    })
    .toBuffer()
  const generatedPath = 'android/app/src/main/res/mipmap-xxxhdpi/ic_launcher.png'

  if (await rawImageHash(expected) !== await rawImageHash(generatedPath)) {
    throw new Error(`${generatedPath} was not generated from ${sources.icon.path}`)
  }
}

async function verifySplash() {
  const generatedPath = 'android/app/src/main/res/drawable-port-mdpi/splash.png'
  const expected = await sharp(sources.splash.path).resize(320, 480).toBuffer()
  if (await rawImageHash(expected) !== await rawImageHash(generatedPath)) {
    throw new Error(`${generatedPath} was not generated from ${sources.splash.path}`)
  }
}

for (const source of Object.values(sources)) {
  const actualHash = sha256(readFileSync(source.path))
  if (actualHash !== source.sha256) {
    throw new Error(`${source.path} is not the expected versioned Knote artwork`)
  }
}

const launcherDensities = ['ldpi', 'mdpi', 'hdpi', 'xhdpi', 'xxhdpi', 'xxxhdpi']
for (const density of launcherDensities) {
  for (const filename of ['ic_launcher.png', 'ic_launcher_round.png']) {
    readFileSync(`android/app/src/main/res/mipmap-${density}/${filename}`)
  }
}
const adaptiveIcon = readFileSync('android/app/src/main/res/mipmap-anydpi-v26/ic_launcher.xml', 'utf8')
if (!adaptiveIcon.includes('@mipmap/ic_launcher_foreground') || !adaptiveIcon.includes('@mipmap/ic_launcher_background')) {
  throw new Error('Generated adaptive launcher icon does not reference branded layers')
}

await verifyLegacyLauncherIcon()
await verifySplash()
console.log('Verified branded Android launcher and splash resources')
