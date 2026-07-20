// Keep Android's native version metadata in sync with package.json.
// The android project is generated/ignored, so this must run after every
// `cap add` or `cap sync` both locally and in the release workflow.
import { readFileSync, writeFileSync } from 'node:fs'

const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
const versionName = String(pkg.version || '').trim()
const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(versionName)
if (!match) throw new Error(`package.json has unsupported version: ${versionName}`)

const major = Number(match[1])
const minor = Number(match[2])
const patch = Number(match[3])
if (minor > 999 || patch > 999) throw new Error(`version components are too large: ${versionName}`)

// Monotonic for semantic versions while remaining below Android's limit for
// normal major versions. v1.0.1 => 1000001, safely above the original code 1.
const versionCode = major * 1_000_000 + minor * 1_000 + patch
const gradlePath = 'android/app/build.gradle'
const original = readFileSync(gradlePath, 'utf8')
const updated = original
  .replace(/\bversionCode\s+\d+/, `versionCode ${versionCode}`)
  .replace(/\bversionName\s+"[^"]*"/, `versionName "${versionName}"`)

if (updated === original && (!original.includes(`versionCode ${versionCode}`) || !original.includes(`versionName "${versionName}"`))) {
  throw new Error(`could not update Android version metadata in ${gradlePath}`)
}
writeFileSync(gradlePath, updated)
console.log(`Android version: ${versionName} (${versionCode})`)
