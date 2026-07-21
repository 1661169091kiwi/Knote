; Knote is tray-resident: its close handler HIDES the window instead of
; quitting, so the installer's polite "please close" request can never
; succeed — the stock CheckAppRunning macro would loop on the retry dialog
; forever. Override it and force-kill instead (twice: something may relaunch
; the app right after the first kill — finish-page autorun, WER restart).
!macro customCheckAppRunning
  ; Knote is tray-resident and spawns GPU/utility child processes that keep
  ; the Electron DLLs (vulkan-1.dll, vk_swiftshader.dll, ffmpeg.dll…) mapped.
  ; /T kills the whole tree, but Windows unmaps those handles ASYNCHRONOUSLY
  ; — the subsequent atomic file-replace during extraction fails while a
  ; stale handle lingers, surfacing the "cannot close" dialog. Kill twice and
  ; give the OS + antivirus a generous settle so every handle is released
  ; before extraction touches the files.
  nsExec::ExecToStack 'taskkill /F /IM Knote.exe /T'
  Pop $0
  Pop $1
  Sleep 1200
  nsExec::ExecToStack 'taskkill /F /IM Knote.exe /T'
  Pop $0
  Pop $1
  Sleep 3000
!macroend

!macro customInit
  nsExec::ExecToStack 'taskkill /F /IM Knote.exe /T'
  Pop $0
  Pop $1
!macroend

; Register Knote as a first-class Windows "Open with" application. The
; electron-builder file-association macro owns the Knote.Markdown ProgID;
; these extra keys make the executable discoverable in Default Apps and keep
; the command an absolute, fully quoted path even when users choose a custom
; install directory.
!macro customInstall
  ; electron-builder quotes "%1" but not the executable in its generated
  ; ProgID command. Override it after APP_ASSOCIATE so paths containing spaces
  ; remain executable (for example "D:\My Apps\Knote\Knote.exe").
  WriteRegStr SHELL_CONTEXT "Software\Classes\Knote.Markdown" "" "Markdown document"
  WriteRegStr SHELL_CONTEXT "Software\Classes\Knote.Markdown\DefaultIcon" "" '"$INSTDIR\Knote.exe",0'
  WriteRegStr SHELL_CONTEXT "Software\Classes\Knote.Markdown\shell" "" "open"
  WriteRegStr SHELL_CONTEXT "Software\Classes\Knote.Markdown\shell\open" "" "Open with Knote"
  WriteRegStr SHELL_CONTEXT "Software\Classes\Knote.Markdown\shell\open\command" "" '"$INSTDIR\Knote.exe" "%1"'

  WriteRegStr SHELL_CONTEXT "Software\Classes\Applications\Knote.exe" "FriendlyAppName" "Knote"
  WriteRegStr SHELL_CONTEXT "Software\Classes\Applications\Knote.exe\DefaultIcon" "" '"$INSTDIR\Knote.exe",0'
  WriteRegStr SHELL_CONTEXT "Software\Classes\Applications\Knote.exe\shell\open\command" "" '"$INSTDIR\Knote.exe" "%1"'
  WriteRegNone SHELL_CONTEXT "Software\Classes\Applications\Knote.exe\SupportedTypes" ".md"
  WriteRegNone SHELL_CONTEXT "Software\Classes\Applications\Knote.exe\SupportedTypes" ".markdown"

  WriteRegStr SHELL_CONTEXT "Software\Knote\Capabilities" "ApplicationName" "Knote"
  WriteRegStr SHELL_CONTEXT "Software\Knote\Capabilities" "ApplicationDescription" "Knote Markdown editor"
  WriteRegStr SHELL_CONTEXT "Software\Knote\Capabilities\FileAssociations" ".md" "Knote.Markdown"
  WriteRegStr SHELL_CONTEXT "Software\Knote\Capabilities\FileAssociations" ".markdown" "Knote.Markdown"
  WriteRegStr SHELL_CONTEXT "Software\RegisteredApplications" "Knote" "Software\Knote\Capabilities"
!macroend

!macro customUnInit
  nsExec::ExecToStack 'taskkill /F /IM Knote.exe /T'
  Pop $0
  Pop $1
!macroend

; Remove only the registration owned by Knote. Windows protects the user's
; explicit UserChoice separately, so the uninstaller never edits that key.
!macro customUnInstall
  ReadRegStr $0 SHELL_CONTEXT "Software\Classes\.md" ""
  ${If} $0 == "Knote.Markdown"
    DeleteRegValue SHELL_CONTEXT "Software\Classes\.md" ""
  ${EndIf}
  ReadRegStr $0 SHELL_CONTEXT "Software\Classes\.markdown" ""
  ${If} $0 == "Knote.Markdown"
    DeleteRegValue SHELL_CONTEXT "Software\Classes\.markdown" ""
  ${EndIf}
  DeleteRegKey SHELL_CONTEXT "Software\Classes\Applications\Knote.exe"
  DeleteRegValue SHELL_CONTEXT "Software\RegisteredApplications" "Knote"
  DeleteRegKey SHELL_CONTEXT "Software\Knote\Capabilities"
!macroend
