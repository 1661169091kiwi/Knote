; Knote installer reliability and migration hooks.
;
; electron-builder normally launches the previous NSIS uninstaller during an
; upgrade.  Older Knote uninstallers can fail after closing the tray process,
; which electron-builder then misreports as "Knote cannot be closed".  Knote
; upgrades are prepared here instead: terminate the complete Electron tree,
; suppress that legacy uninstaller call, and let the new payload replace the
; application files in place.
!include "LogicLib.nsh"
!include "FileFunc.nsh"
!include "nsDialogs.nsh"

!define KNOTE_UNINSTALL_REGISTRY_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${UNINSTALL_APP_KEY}"

; Close the process tree first. Killing only Knote.exe before taskkill /T can
; orphan child helpers, so taskkill owns the entire operation. Repetition
; absorbs Windows handle-release lag without relying on an optional plugin.
!macro KnoteTerminateRunningApp
  nsExec::ExecToStack '"$SYSDIR\taskkill.exe" /F /T /IM "Knote.exe"'
  Pop $0
  Pop $1
  Sleep 700
  nsExec::ExecToStack '"$SYSDIR\taskkill.exe" /F /T /IM "Knote.exe"'
  Pop $0
  Pop $1
  Sleep 800
!macroend

!ifndef BUILD_UNINSTALLER
  Var KnoteLegacyNestedDir
  Var KnoteExistingDir
  Var KnoteInstallChoice
  Var KnoteOtherDir
  Var KnoteChoicePage
  Var KnoteDestinationPage
  Var KnoteChoiceUpdate
  Var KnoteChoiceMoveRemove
  Var KnoteChoiceMoveKeep
  Var KnoteChoiceClose
  Var KnoteChoiceDirField
  Var KnoteChoiceBrowse

  !macro KnoteTryFixedDrive LETTER
    ${If} $R8 == ""
    ${AndIf} $R9 != "${LETTER}:\"
      System::Call 'kernel32::GetDriveTypeW(w "${LETTER}:\\") i .r0'
      ${If} $0 == 3
        StrCpy $R8 "${LETTER}:\Knote"
      ${EndIf}
    ${EndIf}
  !macroend

  !macro KnoteTryExistingDrive LETTER
    ${If} $KnoteExistingDir == ""
      IfFileExists "${LETTER}:\Knote\Knote.exe" 0 +2
        StrCpy $KnoteExistingDir "${LETTER}:\Knote"
    ${EndIf}
  !macroend

  Function KnoteChooseDefaultDir
    ${GetRoot} "$WINDIR" $R9
    StrCpy $R8 ""
    !insertmacro KnoteTryFixedDrive "D"
    !insertmacro KnoteTryFixedDrive "E"
    !insertmacro KnoteTryFixedDrive "F"
    !insertmacro KnoteTryFixedDrive "G"
    !insertmacro KnoteTryFixedDrive "H"
    !insertmacro KnoteTryFixedDrive "I"
    !insertmacro KnoteTryFixedDrive "J"
    !insertmacro KnoteTryFixedDrive "K"
    !insertmacro KnoteTryFixedDrive "L"
    !insertmacro KnoteTryFixedDrive "M"
    !insertmacro KnoteTryFixedDrive "N"
    !insertmacro KnoteTryFixedDrive "O"
    !insertmacro KnoteTryFixedDrive "P"
    !insertmacro KnoteTryFixedDrive "Q"
    !insertmacro KnoteTryFixedDrive "R"
    !insertmacro KnoteTryFixedDrive "S"
    !insertmacro KnoteTryFixedDrive "T"
    !insertmacro KnoteTryFixedDrive "U"
    !insertmacro KnoteTryFixedDrive "V"
    !insertmacro KnoteTryFixedDrive "W"
    !insertmacro KnoteTryFixedDrive "X"
    !insertmacro KnoteTryFixedDrive "Y"
    !insertmacro KnoteTryFixedDrive "Z"
    !insertmacro KnoteTryFixedDrive "A"
    !insertmacro KnoteTryFixedDrive "B"
    !insertmacro KnoteTryFixedDrive "C"
    ${If} $R8 == ""
      StrCpy $R8 "$R9${APP_FILENAME}"
    ${EndIf}
    StrCpy $INSTDIR $R8
  FunctionEnd

  ; Repair a registered <real-dir>\Knote path when the actual application is
  ; one level higher (layout produced by the early 1.0.0 installer).
  Function KnoteRepairLegacyInstallDir
    StrCpy $KnoteLegacyNestedDir ""
    StrCpy $R7 "$INSTDIR" 12 -12
    ${If} $R7 == "\Knote\Knote"
      StrLen $R6 "$INSTDIR"
      IntOp $R6 $R6 - 6
      StrCpy $R5 "$INSTDIR" $R6
      IfFileExists "$R5\Knote.exe" 0 repair_done
      StrCpy $KnoteLegacyNestedDir "$INSTDIR"
      StrCpy $INSTDIR "$R5"
    ${EndIf}
    repair_done:
  FunctionEnd

  Function KnoteFindExistingInstall
    StrCpy $KnoteExistingDir ""

    ReadRegStr $0 HKLM "${KNOTE_UNINSTALL_REGISTRY_KEY}" "InstallLocation"
    ${If} $0 != ""
      IfFileExists "$0\Knote.exe" 0 +2
        StrCpy $KnoteExistingDir "$0"
    ${EndIf}

    ${If} $KnoteExistingDir == ""
      IfFileExists "$INSTDIR\Knote.exe" 0 +2
        StrCpy $KnoteExistingDir "$INSTDIR"
    ${EndIf}

    ; Recover installations made by 1.0.0, which could omit InstallLocation.
    !insertmacro KnoteTryExistingDrive "D"
    !insertmacro KnoteTryExistingDrive "E"
    !insertmacro KnoteTryExistingDrive "F"
    !insertmacro KnoteTryExistingDrive "G"
    !insertmacro KnoteTryExistingDrive "H"
    !insertmacro KnoteTryExistingDrive "I"
    !insertmacro KnoteTryExistingDrive "J"
    !insertmacro KnoteTryExistingDrive "K"
    !insertmacro KnoteTryExistingDrive "L"
    !insertmacro KnoteTryExistingDrive "M"
    !insertmacro KnoteTryExistingDrive "N"
    !insertmacro KnoteTryExistingDrive "O"
    !insertmacro KnoteTryExistingDrive "P"
    !insertmacro KnoteTryExistingDrive "Q"
    !insertmacro KnoteTryExistingDrive "R"
    !insertmacro KnoteTryExistingDrive "S"
    !insertmacro KnoteTryExistingDrive "T"
    !insertmacro KnoteTryExistingDrive "U"
    !insertmacro KnoteTryExistingDrive "V"
    !insertmacro KnoteTryExistingDrive "W"
    !insertmacro KnoteTryExistingDrive "X"
    !insertmacro KnoteTryExistingDrive "Y"
    !insertmacro KnoteTryExistingDrive "Z"
    !insertmacro KnoteTryExistingDrive "A"
    !insertmacro KnoteTryExistingDrive "B"
    !insertmacro KnoteTryExistingDrive "C"

    ${If} $KnoteExistingDir != ""
      StrCpy $INSTDIR "$KnoteExistingDir"
      StrCpy $KnoteOtherDir "$KnoteExistingDir-new"
      StrCpy $KnoteInstallChoice "update"
    ${EndIf}
  FunctionEnd

  Function KnoteBrowseOtherDir
    nsDialogs::SelectFolderDialog "选择新的 Knote 安装位置" "$KnoteOtherDir"
    Pop $0
    ${If} $0 != "error"
      StrCpy $KnoteOtherDir "$0"
      ${NSD_SetText} $KnoteChoiceDirField "$KnoteOtherDir"
    ${EndIf}
  FunctionEnd

  Function KnoteExistingPageCreate
    ${If} $KnoteExistingDir == ""
      Abort
    ${EndIf}

    nsDialogs::Create 1018
    Pop $KnoteChoicePage
    ${If} $KnoteChoicePage == error
      Abort
    ${EndIf}

    ${NSD_CreateLabel} 0 0 100% 16u "检测到已安装的 Knote，请选择处理方式："
    Pop $0
    CreateFont $1 "Segoe UI" 10 600
    SendMessage $0 ${WM_SETFONT} $1 1

    ${NSD_CreateLabel} 0 18u 100% 15u "现有位置：$KnoteExistingDir"
    Pop $0

    ${NSD_CreateRadioButton} 0 37u 100% 17u "1. 在原有位置更新 Knote（推荐）"
    Pop $KnoteChoiceUpdate
    ${NSD_Check} $KnoteChoiceUpdate

    ${NSD_CreateRadioButton} 0 58u 100% 17u "2. 在另一个位置安装，并卸载原来的 Knote"
    Pop $KnoteChoiceMoveRemove

    ${NSD_CreateLabel} 18u 77u 96% 18u "注意：原安装目录中的文件可能会丢失，请先确认其中没有个人文档。"
    Pop $0
    SetCtlColors $0 0xB45309 transparent

    ${NSD_CreateRadioButton} 0 99u 100% 17u "3. 在另一个位置安装，并保留原目录中的 Knote"
    Pop $KnoteChoiceMoveKeep

    ${NSD_CreateRadioButton} 0 120u 100% 17u "4. 关闭安装程序"
    Pop $KnoteChoiceClose

    nsDialogs::Show
  FunctionEnd

  Function KnoteExistingPageLeave
    ${If} $KnoteExistingDir == ""
      Return
    ${EndIf}

    ${NSD_GetState} $KnoteChoiceClose $0
    ${If} $0 == ${BST_CHECKED}
      Quit
    ${EndIf}

    ${NSD_GetState} $KnoteChoiceMoveRemove $0
    ${If} $0 == ${BST_CHECKED}
      StrCpy $KnoteInstallChoice "move-remove"
    ${Else}
      ${NSD_GetState} $KnoteChoiceMoveKeep $0
      ${If} $0 == ${BST_CHECKED}
        StrCpy $KnoteInstallChoice "move-keep"
      ${Else}
        StrCpy $KnoteInstallChoice "update"
      ${EndIf}
    ${EndIf}

    ${If} $KnoteInstallChoice == "update"
      StrCpy $INSTDIR "$KnoteExistingDir"
      Call KnotePrepareExistingInstall
    ${EndIf}
  FunctionEnd

  ; Fresh installations always see this page. For an existing installation it
  ; appears only after option 2 or 3, making "another location" unambiguous.
  Function KnoteDestinationPageCreate
    ${If} $KnoteExistingDir != ""
    ${AndIf} $KnoteInstallChoice == "update"
      Abort
    ${EndIf}

    nsDialogs::Create 1018
    Pop $KnoteDestinationPage
    ${If} $KnoteDestinationPage == error
      Abort
    ${EndIf}

    ${If} $KnoteExistingDir == ""
      ${NSD_CreateLabel} 0 0 100% 18u "选择 Knote 的安装位置"
      Pop $0
      CreateFont $1 "Segoe UI" 10 600
      SendMessage $0 ${WM_SETFONT} $1 1
      ${NSD_CreateLabel} 0 25u 100% 30u "请选择用于安装 Knote 的文件夹。若选择磁盘根目录，将自动使用其中的 Knote 文件夹。"
      Pop $0
      StrCpy $KnoteOtherDir "$INSTDIR"
    ${Else}
      ${NSD_CreateLabel} 0 0 100% 18u "为新的 Knote 选择另一个安装位置"
      Pop $0
      CreateFont $1 "Segoe UI" 10 600
      SendMessage $0 ${WM_SETFONT} $1 1
      ${NSD_CreateLabel} 0 25u 100% 30u "原有位置：$KnoteExistingDir。请选择不同的文件夹；下一步将按刚才的选择处理原版本。"
      Pop $0
    ${EndIf}

    ${NSD_CreateLabel} 0 66u 100% 13u "目标文件夹："
    Pop $0
    ${NSD_CreateText} 0 84u 77% 14u "$KnoteOtherDir"
    Pop $KnoteChoiceDirField
    ${NSD_CreateBrowseButton} 80% 83u 20% 16u "浏览…"
    Pop $KnoteChoiceBrowse
    ${NSD_OnClick} $KnoteChoiceBrowse KnoteBrowseOtherDir

    nsDialogs::Show
  FunctionEnd

  Function KnoteDestinationPageLeave
    ${NSD_GetText} $KnoteChoiceDirField $KnoteOtherDir
    ${If} $KnoteOtherDir == ""
      MessageBox MB_OK|MB_ICONEXCLAMATION "请选择安装位置。"
      Abort
    ${EndIf}

    ; A drive root is never a valid application directory. Normalize D:\ to
    ; D:\Knote and show the actual path before continuing.
    ${GetRoot} "$KnoteOtherDir" $0
    ${If} $KnoteOtherDir == $0
      StrCpy $KnoteOtherDir "$0Knote"
      ${NSD_SetText} $KnoteChoiceDirField "$KnoteOtherDir"
    ${EndIf}

    ${If} $KnoteExistingDir != ""
    ${AndIf} $KnoteOtherDir == $KnoteExistingDir
      MessageBox MB_OK|MB_ICONEXCLAMATION "请选择不同于原版本的位置。"
      Abort
    ${EndIf}

    StrCpy $INSTDIR "$KnoteOtherDir"
    ${If} $KnoteExistingDir != ""
      Call KnotePrepareExistingInstall
    ${EndIf}
  FunctionEnd

  Function KnotePrepareExistingInstall

    ; Do this only after the final relevant page has been accepted. Cancelling
    ; or navigating back therefore never mutates the existing installation.
    !insertmacro KnoteTerminateRunningApp
    nsExec::ExecToStack '"$SYSDIR\cmd.exe" /C tasklist /FI "IMAGENAME eq Knote.exe" /FO CSV /NH | "$SYSDIR\findstr.exe" /B /I /C:"\"Knote.exe\""'
    Pop $0
    Pop $1
    ${If} $0 == 0
      MessageBox MB_OK|MB_ICONSTOP "Knote 仍在运行，安装程序无法安全地继续。请稍后重新运行安装程序。"
      Abort
    ${EndIf}

    ; Suppress electron-builder's call into the old uninstaller. The fresh
    ; installation writes a complete replacement registration after extract.
    DeleteRegValue HKLM "${KNOTE_UNINSTALL_REGISTRY_KEY}" "UninstallString"
    DeleteRegValue HKLM "${KNOTE_UNINSTALL_REGISTRY_KEY}" "QuietUninstallString"
    DeleteRegValue HKCU "${KNOTE_UNINSTALL_REGISTRY_KEY}" "UninstallString"
    DeleteRegValue HKCU "${KNOTE_UNINSTALL_REGISTRY_KEY}" "QuietUninstallString"

    ${If} $KnoteInstallChoice == "move-remove"
      ; The executable check is a safety fence: never recursively remove a
      ; guessed directory. This branch exists only after explicit user choice.
      IfFileExists "$KnoteExistingDir\Knote.exe" 0 old_remove_done
        RMDir /r /REBOOTOK "$KnoteExistingDir"
      old_remove_done:
    ${EndIf}
  FunctionEnd
!endif

!macro customHeader
  BrandingText "Knote"
!macroend

!macro customWelcomePage
  !insertmacro MUI_PAGE_WELCOME
  !ifndef BUILD_UNINSTALLER
    Page custom KnoteExistingPageCreate KnoteExistingPageLeave
    Page custom KnoteDestinationPageCreate KnoteDestinationPageLeave
  !endif
!macroend

; This replaces electron-builder's interactive close loop for both installer
; and uninstaller builds. It never delegates to the tray-aware window close.
!macro customCheckAppRunning
  !insertmacro KnoteTerminateRunningApp
!macroend

!macro customInit
  Call KnoteRepairLegacyInstallDir
  ${If} $KnoteLegacyNestedDir != ""
    StrCpy $perMachineInstallationFolder "$INSTDIR"
  ${EndIf}
  ${If} $perMachineInstallationFolder == ""
    Call KnoteChooseDefaultDir
  ${EndIf}
  Call KnoteFindExistingInstall
!macroend

!macro customInstall
  WriteRegStr HKLM "${KNOTE_UNINSTALL_REGISTRY_KEY}" "InstallLocation" "$INSTDIR"
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
  ${If} $KnoteLegacyNestedDir != ""
    IfFileExists "$KnoteLegacyNestedDir\Knote.exe" 0 +2
      RMDir /r /REBOOTOK "$KnoteLegacyNestedDir"
  ${EndIf}
!macroend

!macro customUnInit
  !insertmacro KnoteTerminateRunningApp
!macroend

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
