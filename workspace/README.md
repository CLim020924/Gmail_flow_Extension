# CMOE Workspace

CMOE Workspace는 명단을 먼저 입력하고, 그 명단을 일정 편성·그룹 구성·Google Forms·Zoom·Gmail Flow 작업에서 함께 사용하는 Windows 데스크톱 플랫폼입니다.

기능별 사용자 요청과 변경 흐름은 [`../docs/REQUEST_CHANGE_LOG.md`](../docs/REQUEST_CHANGE_LOG.md)에서 확인할 수 있습니다. 새 기능을 추가하거나 기존 동작을 바꿀 때 해당 요청 ID, 검증 결과, 커밋을 함께 갱신합니다.

## 유동적인 업무 템플릿

- 새 프로젝트는 KAC 응시자 관리, 교육 프로그램 운영, 안내문·메일, 문서·AI 검토, Excel·명단 정리 또는 빈 프로젝트로 시작할 수 있습니다.
- 각 프로젝트에서 업무 단계의 이름·설명·순서를 바꾸고 필요한 단계를 추가하거나 제거할 수 있습니다.
- 진행상황·문서 검토·AI 활용 단계에는 업무 기준, 체크리스트, 결과 메모와 최종 확인 상태를 저장합니다.
- 현재 업무 구성을 같은 이름으로 다시 저장하면 새 템플릿 버전이 됩니다.
- 템플릿에는 컬럼 구조·역할·규칙·메일/결과표 기본 형식만 저장하며 실제 명단과 개인정보는 포함하지 않습니다.
- 이전 버전 프로젝트는 현재 사용하던 프로그램 순서를 업무 단계로 자동 변환하여 그대로 열립니다.

## 사용자 설치

검증된 `CMOE-Workspace-Setup-1.1.11-Windows.exe`를 실행합니다. 설치형은 바탕화면과 시작 메뉴에 바로가기를 만들며, 사용자 데이터는 프로그램 업데이트 후에도 유지됩니다. 이 저장소는 아직 설치 파일을 GitHub Releases에 자동 게시하지 않으므로, 배포 담당자가 smoke 검사를 통과한 설치 파일을 별도로 전달하거나 수동으로 게시해야 합니다.

## 개발 실행

```powershell
cd workspace
npm ci
npm run desktop
```

Node.js 22와 npm이 필요합니다. `npm ci`는 루트 잠금 파일과 `vendor/package-lock.json`을 사용해 Electron 빌드 도구와 ExcelJS 런타임을 고정된 버전으로 설치합니다.

## 검사와 Windows 설치 파일 빌드

```powershell
cd workspace
npm ci
npm run preflight:build
npm test
npm run smoke
npm run build:installer
```

`build:installer`는 빌드 직전에 같은 사전검사를 자동 실행합니다. 사전검사는 ExcelJS와 전이 의존성이 실제로 로드되는지, 잠금 파일 버전과 일치하는지, 설치본 리소스 경로가 설정되어 있는지를 확인합니다. 완성된 설치 파일은 `workspace/desktop-dist`에 생성되며, 배포 전에 설치된 EXE로 smoke 검사를 다시 통과해야 합니다.

## 계정과 데이터

- 명단·템플릿·프로젝트 데이터는 기본적으로 Electron `userData` 폴더에 저장됩니다.
- 사용자가 선택하면 Google Drive 동기화를 사용할 수 있습니다.
- Google 및 Zoom 계정은 기능별로 별도 등록할 수 있습니다.
- OAuth 비밀번호·토큰과 `desktop/oauth-credentials.local.js`는 Git 저장소와 설치 파일에 포함하지 않습니다. Gmail Flow의 데스크톱 PKCE 로그인은 로컬 Client Secret 파일이 없어도 시작되며, 값이 없으면 토큰 요청에서도 해당 필드를 생략합니다.

## 포함 구조

- 저장소 루트: Gmail Flow 확장 프로그램 및 데스크톱 모듈
- `workspace`: 전체 플랫폼
- `workspace/extensions`: 플랫폼에서 설치·활성화하는 기능 모듈 정의
