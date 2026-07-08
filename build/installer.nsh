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

!macro customUnInit
  nsExec::ExecToStack 'taskkill /F /IM Knote.exe /T'
  Pop $0
  Pop $1
!macroend
