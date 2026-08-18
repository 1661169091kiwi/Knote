// Verify a release APK independently of Gradle before CI is allowed to
// publish it. The signer digest is a public trust anchor pinned below.
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, delimiter, dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const apkPath = resolve(process.argv[2] || '')
const expectedPackage = 'com.kv.knote'
const expectedVersion = String(JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')).version).trim()
const expectedVersionMatch = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(expectedVersion)
if (!expectedVersionMatch) throw new Error(`package.json has unsupported version: ${expectedVersion}`)
const expectedVersionParts = expectedVersionMatch.slice(1, 4).map(Number)
if (expectedVersionParts[1] > 999 || expectedVersionParts[2] > 999) {
  throw new Error(`version components are too large: ${expectedVersion}`)
}
const expectedVersionCode = expectedVersionParts[0] * 1_000_000 + expectedVersionParts[1] * 1_000 + expectedVersionParts[2]
const expectedSigner = normalizeDigest(
  'B6E9E422D92ED613BF02CCEE1D8E10879B82010C6B09223EAFC99F004BAC7427',
  'Pinned Android release signer'
)

if (!process.argv[2] || !existsSync(apkPath) || !statSync(apkPath).isFile()) {
  throw new Error('Usage: node scripts/verify-android-apk.mjs <release.apk>')
}

function normalizeDigest(value, label) {
  const normalized = String(value ?? '').replace(/[\s:]/g, '').toUpperCase()
  if (!/^[0-9A-F]{64}$/.test(normalized)) throw new Error(`${label} must be a 64-character SHA-256 digest`)
  return normalized
}

function executableNames(name) {
  if (process.platform !== 'win32') return [name]
  if (name === 'aapt') return ['aapt.exe']
  return [`${name}.bat`, `${name}.cmd`, `${name}.exe`]
}

function findOnPath(name) {
  for (const directory of String(process.env.PATH || '').split(delimiter)) {
    if (!directory) continue
    for (const filename of executableNames(name)) {
      const candidate = join(directory, filename)
      if (existsSync(candidate)) return candidate
    }
  }
  return null
}

function androidSdkRoots() {
  const roots = [process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT]
  const localPropertiesPath = join(repoRoot, 'android', 'local.properties')
  if (existsSync(localPropertiesPath)) {
    const match = /^sdk\.dir=(.+)$/m.exec(readFileSync(localPropertiesPath, 'utf8'))
    if (match) roots.push(match[1].trim().replace(/\\([\\:= ])/g, '$1'))
  }
  if (process.env.LOCALAPPDATA) roots.push(join(process.env.LOCALAPPDATA, 'Android', 'Sdk'))
  return [...new Set(roots.filter(Boolean))]
}

function findAndroidBuildTools() {
  for (const sdkRoot of androidSdkRoots()) {
    const buildToolsRoot = join(sdkRoot, 'build-tools')
    if (!existsSync(buildToolsRoot)) continue
    const versions = readdirSync(buildToolsRoot)
      .filter((name) => statSync(join(buildToolsRoot, name)).isDirectory())
      .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }))
    for (const version of versions) {
      const directory = join(buildToolsRoot, version)
      const apksigner = executableNames('apksigner').map((name) => join(directory, name)).find(existsSync)
      const aapt = executableNames('aapt').map((name) => join(directory, name)).find(existsSync)
      if (apksigner && aapt) return { apksigner, aapt }
    }
  }

  const apksigner = findOnPath('apksigner')
  const aapt = findOnPath('aapt')
  if (apksigner && aapt) return { apksigner, aapt }
  throw new Error('Android SDK build tools with apksigner and aapt were not found')
}

function runTool(command, args, label) {
  let executable = command
  let executableArgs = args
  if (process.platform === 'win32' && basename(command).toLowerCase() === 'apksigner.bat') {
    const apksignerJar = join(dirname(command), 'lib', 'apksigner.jar')
    if (!existsSync(apksignerJar)) throw new Error('Android SDK apksigner.jar was not found')
    executable = 'java'
    executableArgs = ['-jar', apksignerJar, ...args]
  }

  const result = spawnSync(executable, executableArgs, {
    encoding: 'utf8',
    windowsHide: true
  })
  if (result.error || result.status !== 0) throw new Error(`${label} failed`)
  return `${result.stdout || ''}\n${result.stderr || ''}`
}

const { apksigner, aapt } = findAndroidBuildTools()
const signatureReport = runTool(apksigner, ['verify', '--verbose', '--print-certs', apkPath], 'APK signature verification')
const signerDigests = [...signatureReport.matchAll(/Signer #\d+ certificate SHA-256 digest:\s*([0-9a-f:]+)/gi)]
  .map((match) => normalizeDigest(match[1], 'APK signer digest'))
const uniqueSignerDigests = [...new Set(signerDigests)]
if (uniqueSignerDigests.length !== 1 || uniqueSignerDigests[0] !== expectedSigner) {
  throw new Error('APK signer certificate does not match the source-pinned release signer')
}

const badging = runTool(aapt, ['dump', 'badging', apkPath], 'APK manifest inspection')
const packageLine = /^package:\s+([^\n]+)$/m.exec(badging)?.[1] || ''
const packageName = /\bname='([^']+)'/.exec(packageLine)?.[1]
const versionCode = /\bversionCode='(\d+)'/.exec(packageLine)?.[1]
const versionName = /\bversionName='([^']*)'/.exec(packageLine)?.[1]
if (!packageName || !versionCode || versionName === undefined) throw new Error('Could not read package metadata from the APK')
if (packageName !== expectedPackage) throw new Error(`Unexpected APK package: ${packageName}`)
if (versionName !== expectedVersion) throw new Error(`Unexpected APK versionName: ${versionName}`)
if (versionCode !== String(expectedVersionCode)) throw new Error(`Unexpected APK versionCode: ${versionCode}`)
if (/^application-debuggable(?:\s|$)/m.test(badging)) throw new Error('Release APK is debuggable')

const apkSha256 = createHash('sha256').update(readFileSync(apkPath)).digest('hex')
console.log(`Verified release APK: ${apkPath}`)
console.log(`Package: ${expectedPackage}`)
console.log(`Version: ${expectedVersion} (${expectedVersionCode})`)
console.log('Debuggable: false')
console.log(`APK SHA-256: ${apkSha256}`)
