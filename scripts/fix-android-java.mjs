// Capacitor 8.x ships gradle files targeting Java 21, but this machine's
// toolchain (JDK 17, same as the Koach project) compiles the identical
// sources fine at 17. `cap sync` regenerates capacitor.build.gradle, so this
// patch must run after every sync — wired into the cap:sync / dist:apk
// npm scripts.
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs'

const files = [
  'android/app/capacitor.build.gradle',
  'android/capacitor-cordova-android-plugins/build.gradle',
  'node_modules/@capacitor/android/capacitor/build.gradle'
]

// every installed Capacitor plugin ships its own android/build.gradle with
// the same Java 21 target — patch them all
try {
  for (const pkg of readdirSync('node_modules/@capacitor')) {
    const g = `node_modules/@capacitor/${pkg}/android/build.gradle`
    if (existsSync(g)) files.push(g)
  }
} catch { /* no @capacitor scope */ }

for (const f of files) {
  if (!existsSync(f)) continue
  const text = readFileSync(f, 'utf8')
  // both forms appear across plugins: compileOptions VERSION_21 and the
  // Kotlin-DSL style jvmToolchain(21) / JavaLanguageVersion.of(21)
  const patched = text
    .replace(/VERSION_21/g, 'VERSION_17')
    .replace(/jvmToolchain\(\s*21\s*\)/g, 'jvmToolchain(17)')
    .replace(/JavaLanguageVersion\.of\(\s*21\s*\)/g, 'JavaLanguageVersion.of(17)')
  if (patched !== text) {
    writeFileSync(f, patched)
    console.log(`patched ${f}: Java 21 -> 17`)
  }
}
