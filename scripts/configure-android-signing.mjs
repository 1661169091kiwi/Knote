// The Android project is generated and ignored. Reapply this environment-only
// release signing block after every `cap add`/`cap sync` operation.
import { readFileSync, writeFileSync } from 'node:fs'

const gradlePath = 'android/app/build.gradle'
const requiredEnvironment = [
  'ANDROID_RELEASE_KEYSTORE_PATH',
  'ANDROID_RELEASE_KEYSTORE_PASSWORD',
  'ANDROID_RELEASE_KEY_ALIAS',
  'ANDROID_RELEASE_KEY_PASSWORD'
]
const beginMarker = '/* KNOTE_ANDROID_RELEASE_SIGNING_BEGIN */'
const endMarker = '/* KNOTE_ANDROID_RELEASE_SIGNING_END */'

function missingReleaseEnvironment(environment) {
  return requiredEnvironment.filter((name) => !String(environment[name] ?? '').trim())
}

function requireReleaseEnvironment(environment) {
  const missing = missingReleaseEnvironment(environment)
  if (missing.length) {
    throw new Error(`Missing required Android release signing environment variables: ${missing.join(', ')}`)
  }
}

function markerCount(text, marker) {
  return text.split(marker).length - 1
}

function patchSigningConfig() {
  const original = readFileSync(gradlePath, 'utf8')
  const beginCount = markerCount(original, beginMarker)
  const endCount = markerCount(original, endMarker)

  if (beginCount || endCount) {
    if (beginCount !== 1 || endCount !== 1 || original.indexOf(beginMarker) > original.indexOf(endMarker)) {
      throw new Error(`Refusing to replace a malformed Android signing block in ${gradlePath}`)
    }
    console.log(`Android release signing config already present in ${gradlePath}`)
    return
  }

  const newline = original.includes('\r\n') ? '\r\n' : '\n'
  const signingBlock = `${beginMarker}
// Values are read only from the process environment. The task-graph guard
// makes every release task fail closed, while debug-only task graphs need no
// release credentials.
def knoteReleaseSigningEnvironment = [
    "ANDROID_RELEASE_KEYSTORE_PATH": System.getenv("ANDROID_RELEASE_KEYSTORE_PATH"),
    "ANDROID_RELEASE_KEYSTORE_PASSWORD": System.getenv("ANDROID_RELEASE_KEYSTORE_PASSWORD"),
    "ANDROID_RELEASE_KEY_ALIAS": System.getenv("ANDROID_RELEASE_KEY_ALIAS"),
    "ANDROID_RELEASE_KEY_PASSWORD": System.getenv("ANDROID_RELEASE_KEY_PASSWORD")
]
def knoteMissingReleaseSigningEnvironment = knoteReleaseSigningEnvironment.findAll { name, value ->
    value == null || value.trim().isEmpty()
}.keySet().toList()

gradle.taskGraph.whenReady { taskGraph ->
    def hasReleaseTask = taskGraph.allTasks.any { task ->
        task.name.toLowerCase(java.util.Locale.ROOT).contains("release")
    }
    if (hasReleaseTask && !knoteMissingReleaseSigningEnvironment.isEmpty()) {
        throw new GradleException("Missing required Android release signing environment variables: " +
            knoteMissingReleaseSigningEnvironment.join(", "))
    }
}

if (knoteMissingReleaseSigningEnvironment.isEmpty()) {
    android {
        signingConfigs {
            knoteRelease {
                storeFile file(knoteReleaseSigningEnvironment["ANDROID_RELEASE_KEYSTORE_PATH"])
                storePassword knoteReleaseSigningEnvironment["ANDROID_RELEASE_KEYSTORE_PASSWORD"]
                keyAlias knoteReleaseSigningEnvironment["ANDROID_RELEASE_KEY_ALIAS"]
                keyPassword knoteReleaseSigningEnvironment["ANDROID_RELEASE_KEY_PASSWORD"]
            }
        }
        buildTypes {
            release {
                signingConfig signingConfigs.knoteRelease
            }
        }
    }
}
${endMarker}`.replace(/\n/g, newline)

  const updated = `${original.replace(/[\s\r\n]+$/, '')}${newline}${newline}${signingBlock}${newline}`
  writeFileSync(gradlePath, updated)
  console.log(`Configured environment-only Android release signing in ${gradlePath}`)
}

try {
  const args = process.argv.slice(2)
  const unknownArgs = args.filter((arg) => arg !== '--require-release-secrets')
  if (unknownArgs.length) throw new Error(`Unknown argument: ${unknownArgs[0]}`)
  if (args.includes('--require-release-secrets')) requireReleaseEnvironment(process.env)
  patchSigningConfig()
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
