import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const root = new URL('../', import.meta.url)
const pkg = JSON.parse(await readFile(new URL('package.json', root), 'utf8'))
const nsis = await readFile(new URL('build/installer.nsh', root), 'utf8')
const windowsProbe = await readFile(new URL('scripts/installer-association.windows.integration.mjs', root), 'utf8')
const block = (pattern, label) => {
  const match = nsis.match(pattern)
  assert.ok(match, `missing original installer ${label}`)
  return match[0]
}
const init = block(/!macro customInit[\s\S]*?!macroend/, 'customInit')
const checkRunning = block(/!macro customCheckAppRunning[\s\S]*?!macroend/, 'customCheckAppRunning')
const terminate = block(/!macro KnoteTerminateRunningApp[\s\S]*?!macroend/, 'termination gate')
const findExisting = block(/Function KnoteFindExistingInstall[\s\S]*?FunctionEnd/, 'existing-install lookup')
const chooseExisting = block(/Function KnoteExistingPageLeave[\s\S]*?FunctionEnd/, 'existing-install choice')
const prepareExisting = block(/Function KnotePrepareExistingInstall[\s\S]*?FunctionEnd/, 'existing-install preparation')
const install = block(/!macro customInstall[\s\S]*?!macroend/, 'customInstall')
const uninstall = block(/!macro customUnInstall\r?\n[\s\S]*?!macroend/, 'customUnInstall')

test('electron-builder uses the checked-in installer and does not generate competing associations', () => {
  assert.equal(pkg.build.nsis.include, 'build/installer.nsh')
  assert.equal(pkg.build.nsis.perMachine, true)
  assert.equal(pkg.build.fileAssociations, undefined)
})

test('the Windows installer lets users choose English or Chinese and localizes custom pages', () => {
  assert.deepEqual(pkg.build.nsis.installerLanguages, ['en_US', 'zh_CN'])
  assert.equal(pkg.build.nsis.displayLanguageSelector, true)
  assert.match(nsis, /LangString KnoteExistingHeading 1033 "Knote is already installed\. Choose how to continue:"/)
  assert.match(nsis, /LangString KnoteExistingHeading 2052 "检测到已安装的 Knote，请选择处理方式："/)
  assert.match(nsis, /\$\{NSD_CreateLabel\} 0 0 100% 16u "\$\(KnoteExistingHeading\)"/)
  assert.match(nsis, /nsDialogs::SelectFolderDialog "\$\(KnoteBrowseTitle\)"/)
  assert.match(nsis, /MessageBox MB_OKCANCEL\|MB_ICONEXCLAMATION "\$\(KnoteRunningPrompt\)"/)
})

test('install writes the stable ProgID, Open With application, and Windows capabilities', () => {
  assert.match(install, /Software\\Classes\\Knote\.Markdown\\shell\\open\\command" "" '\"\$INSTDIR\\Knote\.exe\" "%1"'/)
  assert.match(install, /Software\\Classes\\Applications\\Knote\.exe\\shell\\open\\command" "" '\"\$INSTDIR\\Knote\.exe\" "%1"'/)
  assert.match(install, /SupportedTypes" "\.md"/)
  assert.match(install, /SupportedTypes" "\.markdown"/)
  assert.match(install, /Capabilities\\FileAssociations" "\.md" "Knote\.Markdown"/)
  assert.match(install, /Capabilities\\FileAssociations" "\.markdown" "Knote\.Markdown"/)
  assert.match(install, /Software\\RegisteredApplications" "Knote" "Software\\Knote\\Capabilities"/)
  assert.doesNotMatch(install, /Software\\Classes\\\.(?:md|markdown)" ""/)
})

test('repeat install keeps the original location and association classes resolvable until rewrite', () => {
  assert.match(findExisting, /ReadRegStr \$0 HKLM[^\n]+"InstallLocation"/)
  assert.match(findExisting, /StrCpy \$INSTDIR "\$KnoteExistingDir"/)
  assert.match(chooseExisting, /\$KnoteInstallChoice == "update"[\s\S]*StrCpy \$INSTDIR "\$KnoteExistingDir"/)
  assert.ok(checkRunning.indexOf('KnoteTerminateRunningApp') < checkRunning.indexOf('KnotePrepareExistingInstall'))
  assert.doesNotMatch(prepareExisting, /DeleteRegKey[^\n]+Software\\Classes/)
  assert.doesNotMatch(prepareExisting, /Knote\.Markdown|Applications\\Knote\.exe|RegisteredApplications|Capabilities/)
  assert.match(install, /Software\\Classes\\Knote\.Markdown/)
  assert.match(install, /Software\\Classes\\Applications\\Knote\.exe/)
})

test('existing-install preparation suppresses only the legacy uninstaller invocation', () => {
  assert.match(prepareExisting, /DeleteRegValue HKLM[^\n]+"UninstallString"/)
  assert.match(prepareExisting, /DeleteRegValue HKLM[^\n]+"QuietUninstallString"/)
  assert.match(prepareExisting, /DeleteRegValue HKCU[^\n]+"UninstallString"/)
  assert.match(prepareExisting, /DeleteRegValue HKCU[^\n]+"QuietUninstallString"/)
  assert.doesNotMatch(prepareExisting, /ExecWait|uninstaller\.exe/i)
})

test('the original running-app gate is conditional and never launches Knote on a normal install', () => {
  const firstCheck = terminate.indexOf('KnoteCheckRunning')
  const runningBranch = terminate.indexOf('${If} $0 == 0', firstCheck)
  const taskkill = terminate.indexOf('taskkill.exe', runningBranch)
  assert.ok(firstCheck >= 0 && runningBranch > firstCheck && taskkill > runningBranch)
  assert.match(checkRunning, /!insertmacro KnoteTerminateRunningApp/)
  assert.doesNotMatch(init, /KnoteTerminateRunningApp/)
  assert.doesNotMatch(nsis, /\bExec(?:Wait)?\s+['"]?"\$(?:INSTDIR|KnoteExistingDir)\\Knote\.exe"/i)
})

test('uninstall removes legacy extension defaults only when Knote owns them', () => {
  assert.match(uninstall, /ReadRegStr \$0 SHELL_CONTEXT "Software\\Classes\\\.md" ""[\s\S]*\$0 == "Knote\.Markdown"[\s\S]*DeleteRegValue SHELL_CONTEXT "Software\\Classes\\\.md" ""/)
  assert.match(uninstall, /ReadRegStr \$0 SHELL_CONTEXT "Software\\Classes\\\.markdown" ""[\s\S]*\$0 == "Knote\.Markdown"[\s\S]*DeleteRegValue SHELL_CONTEXT "Software\\Classes\\\.markdown" ""/)
  assert.match(uninstall, /DeleteRegKey SHELL_CONTEXT "Software\\Classes\\Applications\\Knote\.exe"/)
  assert.match(uninstall, /DeleteRegValue SHELL_CONTEXT "Software\\RegisteredApplications" "Knote"/)
})

test('the Windows repeat-install probe exercises real registry state without forging UserChoice', () => {
  assert.match(windowsProbe, /neither UserChoice nor HKCR extension defaults currently select Knote/)
  assert.match(windowsProbe, /protectedKnoteChoices\.length > 0 \|\| legacyKnoteDefaults\.length > 0/)
  assert.match(windowsProbe, /!before\[extension\]\.progId && !before\[extension\]\.hash/)
  assert.match(windowsProbe, /after\.extensionDefaults\[extension\][\s\S]*before\.extensionDefaults\[extension\]/)
  assert.match(windowsProbe, /protectedUserChoiceVerified: protectedKnoteChoices\.length > 0/)
  assert.match(windowsProbe, /--require-protected-user-choice/)
  assert.match(windowsProbe, /spawn\(installer, \['\/S', '\/allusers'\]/)
  assert.match(windowsProbe, /samples\.every\(\(item\) => item\.markdown\)/)
  assert.match(windowsProbe, /samples\.every\(\(item\) => item\.application\)/)
  assert.doesNotMatch(windowsProbe, /reg\.exe['"],\s*\[['"](?:add|delete)['"]/i)
})
