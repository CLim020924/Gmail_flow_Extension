!include "LogicLib.nsh"
!include "WordFunc.nsh"
!include "nsDialogs.nsh"
!insertmacro VersionCompare

!ifndef BUILD_UNINSTALLER

Var CmoeInstalledVersion
Var CmoeUninstallCommand
Var CmoeInstallLocation
Var CmoeExpectedUninstaller
Var CmoeVersionRelation
Var CmoeMaintenanceTitle
Var CmoeMaintenanceCopy
Var CmoeUpdateButton
Var CmoeRemoveButton
Var CmoeCloseButton

!macro customInit
  StrCpy $CmoeInstalledVersion ""
  StrCpy $CmoeUninstallCommand ""
  StrCpy $CmoeInstallLocation ""
  StrCpy $CmoeExpectedUninstaller ""
  ReadRegStr $CmoeInstalledVersion HKCU "${UNINSTALL_REGISTRY_KEY}" "DisplayVersion"
  ReadRegStr $CmoeUninstallCommand HKCU "${UNINSTALL_REGISTRY_KEY}" "UninstallString"
  ReadRegStr $CmoeInstallLocation HKCU "${UNINSTALL_REGISTRY_KEY}" "InstallLocation"
  ${If} $CmoeInstalledVersion == ""
    ReadRegStr $CmoeInstalledVersion HKLM "${UNINSTALL_REGISTRY_KEY}" "DisplayVersion"
    ReadRegStr $CmoeUninstallCommand HKLM "${UNINSTALL_REGISTRY_KEY}" "UninstallString"
    ReadRegStr $CmoeInstallLocation HKLM "${UNINSTALL_REGISTRY_KEY}" "InstallLocation"
  ${EndIf}
  ${If} $CmoeInstalledVersion != ""
    ${If} $CmoeInstallLocation != ""
      StrCpy $CmoeExpectedUninstaller "$CmoeInstallLocation\Uninstall CMOE Workspace.exe"
      IfFileExists "$CmoeExpectedUninstaller" +2 0
      StrCpy $CmoeExpectedUninstaller ""
    ${EndIf}
    ${VersionCompare} "$CmoeInstalledVersion" "${VERSION}" $CmoeVersionRelation
    ${If} ${Silent}
    ${AndIf} $CmoeVersionRelation != "2"
      SetErrorLevel 10
      Quit
    ${EndIf}
  ${EndIf}
!macroend

!macro customWelcomePage
  Page custom CmoeMaintenancePageShow CmoeMaintenancePageLeave
!macroend

Function CmoeMaintenancePageShow
  ${If} $CmoeInstalledVersion == ""
    Abort
  ${EndIf}
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}

  ${NSD_CreateLabel} 0 4u 100% 18u "CMOE Workspace가 이미 설치되어 있습니다."
  Pop $CmoeMaintenanceTitle
  CreateFont $1 "$(^Font)" "12" "700"
  SendMessage $CmoeMaintenanceTitle ${WM_SETFONT} $1 1
  ${NSD_CreateLabel} 0 28u 100% 34u "현재 설치 버전: $CmoeInstalledVersion$\r$\n설치 파일 버전: ${VERSION}"
  Pop $CmoeMaintenanceCopy

  ${If} $CmoeVersionRelation == "2"
    ${NSD_CreateButton} 0 76u 31% 18u "업데이트"
    Pop $CmoeUpdateButton
    ${NSD_OnClick} $CmoeUpdateButton CmoeChooseUpdate
    ${NSD_CreateButton} 34% 76u 31% 18u "제거"
    Pop $CmoeRemoveButton
    ${NSD_CreateButton} 68% 76u 31% 18u "닫기"
    Pop $CmoeCloseButton
  ${Else}
    ${NSD_CreateLabel} 0 62u 100% 12u "동일 버전 재설치와 다운그레이드는 지원하지 않습니다."
    Pop $2
    ${NSD_CreateButton} 17% 82u 31% 18u "제거"
    Pop $CmoeRemoveButton
    ${NSD_CreateButton} 52% 82u 31% 18u "닫기"
    Pop $CmoeCloseButton
  ${EndIf}
  ${NSD_OnClick} $CmoeRemoveButton CmoeChooseRemove
  ${NSD_OnClick} $CmoeCloseButton CmoeChooseClose
  nsDialogs::Show
FunctionEnd

Function CmoeMaintenancePageLeave
  ${If} $CmoeVersionRelation != "2"
    Abort
  ${EndIf}
FunctionEnd

Function CmoeChooseUpdate
  SendMessage $HWNDPARENT ${WM_COMMAND} 1 0
FunctionEnd

Function CmoeChooseRemove
  ${If} $CmoeExpectedUninstaller == ""
    MessageBox MB_OK|MB_ICONSTOP "이 설치에 속한 제거 프로그램을 확인하지 못했습니다. 임의의 경로를 실행하지 않습니다. Windows 설정의 설치된 앱에서 CMOE Workspace를 확인해주세요."
    Return
  ${EndIf}
  ExecWait '"$CmoeExpectedUninstaller"'
  Quit
FunctionEnd

Function CmoeChooseClose
  Quit
FunctionEnd

!endif
