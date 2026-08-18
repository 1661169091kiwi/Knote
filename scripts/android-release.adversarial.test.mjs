import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { extractApplicationSignerDigests } from './android-apk-signature.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const signingScript = join(repoRoot, 'scripts', 'configure-android-signing.mjs')
const versionScript = join(repoRoot, 'scripts', 'set-android-version.mjs')
const requiredSigningEnvironment = [
  'ANDROID_RELEASE_KEYSTORE_PATH',
  'ANDROID_RELEASE_KEYSTORE_PASSWORD',
  'ANDROID_RELEASE_KEY_ALIAS',
  'ANDROID_RELEASE_KEY_PASSWORD'
]

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'knote-android-signing-'))
  const appDirectory = join(directory, 'android', 'app')
  mkdirSync(appDirectory, { recursive: true })
  writeFileSync(join(appDirectory, 'build.gradle'), `plugins { id 'com.android.application' }\n\nandroid {\n    buildTypes {\n        release { minifyEnabled false }\n    }\n}\n`)
  return directory
}

function signingEnvironment(overrides = {}) {
  const environment = { ...process.env }
  for (const name of requiredSigningEnvironment) delete environment[name]
  return { ...environment, ...overrides }
}

function runSigningScript(cwd, environment, args = []) {
  return spawnSync(process.execPath, [signingScript, ...args], {
    cwd,
    env: environment,
    encoding: 'utf8',
    windowsHide: true
  })
}

function versionFixture(buildGradle, version = '2.3.4') {
  const directory = mkdtempSync(join(tmpdir(), 'knote-android-version-'))
  const appDirectory = join(directory, 'android', 'app')
  mkdirSync(appDirectory, { recursive: true })
  writeFileSync(join(directory, 'package.json'), JSON.stringify({ version }))
  writeFileSync(join(appDirectory, 'build.gradle'), buildGradle)
  return directory
}

function runVersionScript(cwd) {
  return spawnSync(process.execPath, [versionScript], {
    cwd,
    encoding: 'utf8',
    windowsHide: true
  })
}

test('release preflight fails closed when any signing value is missing', () => {
  const directory = fixture()
  try {
    const result = runSigningScript(directory, signingEnvironment({
      ANDROID_RELEASE_KEYSTORE_PATH: join(directory, 'temporary-test.jks'),
      ANDROID_RELEASE_KEYSTORE_PASSWORD: 'temporary-store-password',
      ANDROID_RELEASE_KEY_ALIAS: 'temporary-alias'
    }), ['--require-release-secrets'])

    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /ANDROID_RELEASE_KEY_PASSWORD/)
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, /temporary-store-password|temporary-alias/)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('complete temporary environment creates an environment-only idempotent signing block', () => {
  const directory = fixture()
  try {
    const temporaryValues = {
      ANDROID_RELEASE_KEYSTORE_PATH: join(directory, 'temporary-test.jks'),
      ANDROID_RELEASE_KEYSTORE_PASSWORD: 'temporary-store-password',
      ANDROID_RELEASE_KEY_ALIAS: 'temporary-alias',
      ANDROID_RELEASE_KEY_PASSWORD: 'temporary-key-password'
    }
    const first = runSigningScript(directory, signingEnvironment(temporaryValues), ['--require-release-secrets'])
    assert.equal(first.status, 0, first.stderr)

    const gradlePath = join(directory, 'android', 'app', 'build.gradle')
    const once = readFileSync(gradlePath, 'utf8')
    for (const name of requiredSigningEnvironment) {
      assert.match(once, new RegExp(`System\\.getenv\\("${name}"\\)`))
      assert.equal(once.includes(temporaryValues[name]), false, `${name} value leaked into build.gradle`)
    }
    assert.match(once, /taskGraph\.allTasks\.any/)
    assert.match(once, /hasReleaseTask && !knoteMissingReleaseSigningEnvironment\.isEmpty\(\)/)
    assert.match(once, /signingConfig signingConfigs\.knoteRelease/)

    const second = runSigningScript(directory, signingEnvironment(temporaryValues))
    assert.equal(second.status, 0, second.stderr)
    assert.equal(readFileSync(gradlePath, 'utf8'), once)
    assert.equal((once.match(/KNOTE_ANDROID_RELEASE_SIGNING_BEGIN/g) || []).length, 1)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('Android version patch requires both metadata fields before writing either one', () => {
  const validDirectory = versionFixture(`android {\n    defaultConfig {\n        versionCode 1\n        versionName "0.1.0"\n    }\n}\n`)
  try {
    const result = runVersionScript(validDirectory)
    assert.equal(result.status, 0, result.stderr)
    const gradle = readFileSync(join(validDirectory, 'android', 'app', 'build.gradle'), 'utf8')
    assert.match(gradle, /versionCode 2003004/)
    assert.match(gradle, /versionName "2\.3\.4"/)
  } finally {
    rmSync(validDirectory, { recursive: true, force: true })
  }

  const incompleteCases = [
    {
      missing: 'versionCode',
      gradle: `android {\n    defaultConfig {\n        versionName "0.1.0"\n    }\n}\n`
    },
    {
      missing: 'versionName',
      gradle: `android {\n    defaultConfig {\n        versionCode 1\n    }\n}\n`
    }
  ]
  for (const fixtureCase of incompleteCases) {
    const directory = versionFixture(fixtureCase.gradle)
    try {
      const gradlePath = join(directory, 'android', 'app', 'build.gradle')
      const before = readFileSync(gradlePath, 'utf8')
      const result = runVersionScript(directory)
      assert.notEqual(result.status, 0)
      assert.match(result.stderr, new RegExp(fixtureCase.missing))
      assert.equal(readFileSync(gradlePath, 'utf8'), before, 'partial Android version metadata was written')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  }
})

test('package scripts keep deterministic branding, signed release, and local debug commands', () => {
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))
  assert.equal(pkg.devDependencies['@capacitor/assets'], '3.0.5')

  const assets = pkg.scripts['android:assets']
  assert.match(assets, /capacitor-assets generate --android/)
  assert.match(assets, /--assetPath assets/)
  assert.match(assets, /verify-android-assets\.mjs/)

  const sync = pkg.scripts['cap:sync']
  const orderedSyncParts = [
    'cap sync android',
    'npm run android:assets',
    'scripts/set-android-version.mjs',
    'scripts/configure-android-signing.mjs',
    'scripts/fix-android-java.mjs'
  ]
  let previousIndex = -1
  for (const part of orderedSyncParts) {
    const index = sync.indexOf(part)
    assert.ok(index > previousIndex, `${part} is out of order in cap:sync`)
    previousIndex = index
  }

  assert.match(pkg.scripts['dist:apk'], /--require-release-secrets/)
  assert.match(pkg.scripts['dist:apk'], /assembleRelease/)
  assert.doesNotMatch(pkg.scripts['dist:apk'], /assembleDebug/)
  assert.match(pkg.scripts['dist:apk:debug'], /assembleDebug/)
  assert.doesNotMatch(pkg.scripts['dist:apk:debug'], /require-release-secrets/)
  assert.match(pkg.scripts.test, /test:android-release/)

  const verifier = readFileSync(join(repoRoot, 'scripts', 'verify-android-assets.mjs'), 'utf8')
  assert.match(verifier, /assets\/icon\.png/)
  assert.match(verifier, /assets\/splash\.png/)
  assert.match(verifier, /mipmap-xxxhdpi\/ic_launcher\.png/)
})

test('APK signer reports accept application signer variants but exclude source stamps', () => {
  const applicationLines = [
    [`Signer #1 certificate SHA-256 digest: ${'1'.repeat(64)}`, '1'.repeat(64)],
    [`Signer (minSdkVersion=24, maxSdkVersion=32) certificate SHA-256 digest: ${'2'.repeat(64)}`, '2'.repeat(64)],
    [`Signer (minSdkVersion=35 (dev release=true), maxSdkVersion=2147483647) certificate SHA-256 digest: ${'3'.repeat(64)}`, '3'.repeat(64)],
    [`V1 Signer: certificate SHA-256 digest: ${'4'.repeat(64)}`, '4'.repeat(64)],
    [`V2 Signer: certificate SHA-256 digest: ${'5'.repeat(64)}`, '5'.repeat(64)],
    [`V2 Signer #1: certificate SHA-256 digest: ${'6'.repeat(64)}`, '6'.repeat(64)],
    [`V3.0 Signer: certificate SHA-256 digest: ${'7'.repeat(64)}`, '7'.repeat(64)],
    [`V3.1 Signer: (minSdkVersion=33, maxSdkVersion=2147483647) certificate SHA-256 digest: ${'8'.repeat(64)}`, '8'.repeat(64)],
    [`V3.0 Signer: (minSdkVersion=24, maxSdkVersion=32) certificate SHA-256 digest: ${'9'.repeat(64)}`, '9'.repeat(64)],
    [`V3.2 Hybrid Classical Signer: (minSdkVersion=35, maxSdkVersion=2147483647) certificate SHA-256 digest: ${'A'.repeat(64)}`, 'A'.repeat(64)],
    [`V3.2 Hybrid PQC Signer: (minSdkVersion=35, maxSdkVersion=2147483647) certificate SHA-256 digest: ${'B'.repeat(64)}`, 'B'.repeat(64)]
  ]
  const report = [
    ...applicationLines.map(([line]) => line),
    `Source Stamp Signer certificate SHA-256 digest: ${'C'.repeat(64)}`,
    `Source Stamp Signer: certificate SHA-256 digest: ${'D'.repeat(64)}`
  ].join('\r\n')

  assert.deepEqual(extractApplicationSignerDigests(report), applicationLines.map(([, digest]) => digest))
  for (const invalid of [
    'Verified using v2 scheme (APK Signature Scheme v2): true',
    `Signer (minSdkVersion=33) certificate SHA-256 digest: ${'D'.repeat(64)}`,
    `V2 Signer: certificate SHA-256 digest: ${'E'.repeat(63)}`,
    `V2 Signer: certificate SHA-256 digest: ${'E'.repeat(65)}`,
    `V2 Signer: certificate SHA-256 digest: ${'F'.repeat(64)} trailing`,
    `V2 Signer: public key SHA-256 digest: ${'F'.repeat(64)}`,
    `Source Stamp Signer: certificate SHA-256 digest: ${'F'.repeat(64)}`
  ]) {
    assert.deepEqual(extractApplicationSignerDigests(invalid), [])
  }
})

test('release workflow validates, tests, verifies, and atomically publishes', () => {
  const workflow = readFileSync(join(repoRoot, '.github', 'workflows', 'release.yml'), 'utf8')
  const validateIndex = workflow.indexOf('  validate:')
  const androidIndex = workflow.indexOf('  android:')
  const windowsIndex = workflow.indexOf('  windows:')
  const publishIndex = workflow.indexOf('  publish:')
  assert.ok(validateIndex >= 0 && validateIndex < androidIndex)
  assert.ok(androidIndex < windowsIndex && windowsIndex < publishIndex)

  const validateJob = workflow.slice(validateIndex, androidIndex)
  const androidJob = workflow.slice(androidIndex, windowsIndex)
  const windowsJob = workflow.slice(windowsIndex, publishIndex)
  const publishJob = workflow.slice(publishIndex)

  assert.match(workflow.slice(0, validateIndex), /concurrency:[\s\S]*group:\s*release-\$\{\{ github\.ref \}\}[\s\S]*cancel-in-progress:\s*false/)
  assert.match(validateJob, /fetch-depth:\s*0/)
  assert.match(validateJob, /package_version="\$\(node -p "require\('\.\/package\.json'\)\.version"\)"/)
  assert.match(validateJob, /expected_tag="v\$\{package_version\}"/)
  assert.match(validateJob, /"\$GITHUB_REF_NAME" != "\$expected_tag"/)
  assert.match(validateJob, /git fetch --no-tags origin '.*refs\/heads\/main:refs\/remotes\/origin\/main'/)
  assert.match(validateJob, /git merge-base --is-ancestor HEAD refs\/remotes\/origin\/main/)
  assert.match(androidJob, /needs:\s*validate/)
  assert.match(windowsJob, /needs:\s*validate/)

  assert.match(androidJob, /environment:\s*android-release/)
  assert.match(androidJob, /npx cap add android/)
  assert.match(androidJob, /npm run cap:sync/)
  assert.ok(androidJob.indexOf('npx cap add android') < androidJob.indexOf('npm run cap:sync'))
  assert.doesNotMatch(workflow, /\$\{\{\s*runner\.temp/)
  assert.match(androidJob, /RUNNER_TEMP/)
  assert.match(androidJob, /ANDROID_RELEASE_KEYSTORE_PATH=.*>> "\$GITHUB_ENV"/)
  assert.ok(androidJob.indexOf('name: Set temporary release keystore path') < androidJob.indexOf('name: Decode temporary release keystore'))

  const nativeTestIndex = androidJob.indexOf(':knote-capacitor-android:testDebugUnitTest')
  const decodeIndex = androidJob.indexOf('name: Decode temporary release keystore')
  const certificateIndex = androidJob.indexOf('name: Verify release keystore certificate')
  const assembleIndex = androidJob.indexOf('assembleRelease')
  assert.ok(nativeTestIndex >= 0 && nativeTestIndex < decodeIndex && decodeIndex < certificateIndex && certificateIndex < assembleIndex)
  assert.match(androidJob, /keytool -exportcert/)
  assert.match(androidJob, /storepass:env ANDROID_RELEASE_KEYSTORE_PASSWORD/)
  assert.match(androidJob, /sha256sum "\$cert_path"/)
  assert.match(androidJob, /Release keystore certificate does not match the source-pinned signer/)
  assert.doesNotMatch(androidJob, /assembleDebug|app-debug/i)
  assert.match(androidJob, /scripts\/verify-android-apk\.mjs/)
  assert.match(androidJob, /com\.kv\.knote/)
  assert.match(androidJob, /versionName\/versionCode/)

  const expectedSecrets = [
    'ANDROID_RELEASE_KEYSTORE_BASE64',
    'ANDROID_RELEASE_KEYSTORE_PASSWORD',
    'ANDROID_RELEASE_KEY_ALIAS',
    'ANDROID_RELEASE_KEY_PASSWORD'
  ]
  const actualSecrets = [...new Set([...workflow.matchAll(/secrets\.([A-Z0-9_]+)/g)].map((match) => match[1]))].sort()
  assert.deepEqual(actualSecrets, expectedSecrets.sort())

  const verifyIndex = androidJob.indexOf('name: Verify signed Android release APK')
  const cleanupIndex = androidJob.indexOf('name: Delete temporary Android keystore')
  const uploadIndex = androidJob.indexOf('uses: actions/upload-artifact@v4')
  assert.ok(verifyIndex >= 0 && verifyIndex < cleanupIndex)
  assert.ok(cleanupIndex < uploadIndex)
  assert.match(androidJob.slice(cleanupIndex, uploadIndex), /if: always\(\)/)
  assert.match(androidJob, /Previous debug-signed APKs cannot be updated in place/)
  assert.doesNotMatch(androidJob, /set -x|printenv|echo \$ANDROID_RELEASE/)
  assert.doesNotMatch(workflow, /issues:\s*write|gh issue create/)

  assert.match(androidJob, /name:\s*knote-android-release/)
  assert.match(windowsJob, /name:\s*knote-windows-release/)
  assert.doesNotMatch(workflow, /softprops\/action-gh-release/)
  assert.match(publishJob, /needs:\s*\[android, windows\]/)
  assert.match(publishJob, /actions\/download-artifact@v4/)
  assert.match(publishJob, /Expected exactly one verified Android APK and one Windows installer/)
  assert.match(publishJob, /Knote-\$\{GITHUB_REF_NAME\}-android-release\.apk/)
  assert.match(publishJob, /Knote-Setup-\$\{expected_version\}\.exe/)
  assert.match(publishJob, /A GitHub Release already exists for \$GITHUB_REF_NAME; refusing to mutate it/)
  assert.match(publishJob, /draft:\s*true, prerelease:\s*false/)
  assert.match(publishJob, /knote-release-run:\$\{GITHUB_RUN_ID\}:\$\{GITHUB_RUN_ATTEMPT\}/)
  assert.match(publishJob, /gh release upload "\$GITHUB_REF_NAME"/)
  assert.doesNotMatch(publishJob, /--clobber/)
  assert.match(publishJob, /length == 2/)
  assert.match(publishJob, /-F draft=false/)
  assert.match(publishJob, /\.draft == true and \(\.body \| contains\(\$marker\)\)/)
  assert.match(publishJob, /gh api --method DELETE "\/repos\/\$\{GITHUB_REPOSITORY\}\/releases\/\$\{release_id\}"/)
  assert.match(publishJob, /Android signing transition:[\s\S]*Back up[\s\S]*Uninstall[\s\S]*reinstall/)
  const refuseIndex = publishJob.indexOf('A GitHub Release already exists')
  const createIndex = publishJob.indexOf('knote-release-created-')
  const releaseUploadIndex = publishJob.indexOf('gh release upload')
  const remoteVerifyIndex = publishJob.indexOf('knote-release-assets-')
  const publishDraftIndex = publishJob.indexOf('-F draft=false')
  assert.ok(refuseIndex >= 0 && refuseIndex < createIndex)
  assert.ok(createIndex < releaseUploadIndex && releaseUploadIndex < remoteVerifyIndex && remoteVerifyIndex < publishDraftIndex)
  assert.doesNotMatch(workflow, /Get-Content .* -Tail|cat .*\.log/)

  const apkVerifier = readFileSync(join(repoRoot, 'scripts', 'verify-android-apk.mjs'), 'utf8')
  assert.match(apkVerifier, /apksigner/)
  assert.match(apkVerifier, /com\.kv\.knote/)
  assert.match(apkVerifier, /versionName/)
  assert.match(apkVerifier, /versionCode/)
  assert.match(apkVerifier, /application-debuggable/)
  assert.match(apkVerifier, /B6E9E422D92ED613BF02CCEE1D8E10879B82010C6B09223EAFC99F004BAC7427/)
  assert.match(apkVerifier, /returned no application signer certificate digest/)
  assert.match(apkVerifier, /multiple application signer certificates/)
  const signerParser = readFileSync(join(repoRoot, 'scripts', 'android-apk-signature.mjs'), 'utf8')
  assert.match(signerParser, /APPLICATION_SIGNER_DIGEST/)
  assert.doesNotMatch(signerParser, /Source Stamp Signer/)
  assert.doesNotMatch(apkVerifier, /process\.env\.[A-Z0-9_]*CERT/)
  assert.match(apkVerifier, /android', 'local\.properties/)
  assert.doesNotMatch(apkVerifier, /shell:\s*true/)
})

test('release documentation distinguishes local builds and Android native-first transport', () => {
  const readme = readFileSync(join(repoRoot, 'README.md'), 'utf8')
  assert.match(readme, /npm run dist:apk:debug[\s\S]{0,160}android\/app\/build\/outputs\/apk\/debug\/app-debug\.apk/)
  assert.match(readme, /npm run dist:apk\s+[\s\S]{0,120}android\/app\/build\/outputs\/apk\/release\/app-release\.apk/)
  assert.match(readme, /Android 签名迁移[\s\S]*v1\.1\.37[\s\S]*备份[\s\S]*卸载[\s\S]*重新安装/)
  assert.match(readme, /Android signing transition[\s\S]*v1\.1\.37[\s\S]*Back up[\s\S]*uninstall[\s\S]*reinstall/i)
  assert.match(readme, /Android 的模型 JSON POST 从第一跳就走原生 HTTP/)
  assert.match(readme, /provider JSON POSTs use native HTTP from the first attempt/)
  assert.doesNotMatch(readme, /renderer-level network\/CORS failure retries|Android debug APK/)

  const handoff = readFileSync(join(repoRoot, 'docs', 'Knote-项目交接文档.md'), 'utf8')
  assert.match(handoff, /已发布版本：`v1\.1\.31` → `v1\.1\.37`/)
  assert.match(handoff, /应用版本 `1\.1\.42`/)
  assert.match(handoff, /`v\$\{package\.json\.version\}`/)
  assert.match(handoff, /npm run dist:apk:debug/)
  assert.match(handoff, /:knote-capacitor-android:testDebugUnitTest/)
  assert.match(handoff, /单一 publish job/)
  assert.match(handoff, /`v1\.1\.38`[\s\S]*`v1\.1\.39`[\s\S]*`v1\.1\.40`[\s\S]*`v1\.1\.41`[\s\S]*`v1\.1\.42` 修复|`v1\.1\.42`[\s\S]*待远端验证/)
  assert.match(handoff, /`android-release` environment 已创建，仅允许 `v\*` tag/)
  assert.match(handoff, /无法同时启用独立 required reviewer/)
  assert.match(handoff, /公开证书 SHA-256 已固定在 `verify-android-apk\.mjs`，不是 secret/)
  assert.doesNotMatch(handoff, /CI 用 21|1\.1\.31–v1\.1\.36/)
})

test('private Android signing and property files remain ignored', () => {
  const gitignore = readFileSync(join(repoRoot, '.gitignore'), 'utf8')
  for (const pattern of ['*.keystore', '*.jks', '*.p12', '*.pfx', 'key.properties', 'keystore.properties', 'signing.properties', 'secrets.properties', 'local.properties']) {
    assert.ok(gitignore.includes(pattern), `${pattern} is not ignored`)
  }
  assert.match(gitignore, /^\/android\/$/m)
  assert.doesNotMatch(gitignore, /^!\/android/m)
})
