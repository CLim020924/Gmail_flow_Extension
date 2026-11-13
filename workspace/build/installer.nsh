!include "LogicLib.nsh"
!include "WordFunc.nsh"
!insertmacro VersionCompare

!ifndef BUILD_UNINSTALLER

Var CmoeInstalledVersion
Var CmoeVersionRelation

!macro customInit
  StrCpy $CmoeInstalledVersion ""
  ReadRegStr $CmoeInstalledVersion HKCU "${UNINSTALL_REGISTRY_KEY}" "DisplayVersion"
  ${If} $CmoeInstalledVersion == ""
    ReadRegStr $CmoeInstalledVersion HKLM "${UNINSTALL_REGISTRY_KEY}" "DisplayVersion"
  ${EndIf}
  ${If} $CmoeInstalledVersion != ""
    ${VersionCompare} "$CmoeInstalledVersion" "${VERSION}" $CmoeVersionRelation
    ${If} $CmoeVersionRelation != "2"
      ${If} ${Silent}
        SetErrorLevel 10
      ${ElseIf} $CmoeVersionRelation == "0"
        MessageBox MB_OK|MB_ICONINFORMATION "CMOE Workspace ${VERSION}이 이미 설치되어 있습니다. 설치된 앱을 사용하거나 Windows의 설치된 앱에서 제거해주세요."
      ${Else}
        MessageBox MB_OK|MB_ICONINFORMATION "현재 설치된 CMOE Workspace $CmoeInstalledVersion이 이 설치 파일보다 최신입니다. 현재 앱을 그대로 사용해주세요."
      ${EndIf}
      Quit
    ${EndIf}
  ${EndIf}
!macroend

!macro customInstall
  ; electron-builder normally keeps an existing shortcut during an update.
  ; Recreate only shortcuts the user already had so their target and icon are
  ; guaranteed to reference the just-installed executable, while respecting a
  ; user who deliberately removed the desktop shortcut.
  ${If} ${FileExists} "$newDesktopLink"
    Delete "$newDesktopLink"
    CreateShortCut "$newDesktopLink" "$appExe" "" "$appExe" 0 SW_SHOWNORMAL "" "CMOE Workspace"
    WinShell::SetLnkAUMI "$newDesktopLink" "${APP_ID}"
  ${EndIf}
  ${If} ${FileExists} "$newStartMenuLink"
    Delete "$newStartMenuLink"
    CreateShortCut "$newStartMenuLink" "$appExe" "" "$appExe" 0 SW_SHOWNORMAL "" "CMOE Workspace"
    WinShell::SetLnkAUMI "$newStartMenuLink" "${APP_ID}"
  ${EndIf}
  System::Call 'Shell32::SHChangeNotify(i 0x8000000, i 0, i 0, i 0)'
!macroend

!endif
