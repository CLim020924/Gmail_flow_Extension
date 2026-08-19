# CMOE Workspace

CMOE Workspace는 명단을 먼저 입력하고, 그 명단을 일정 편성·그룹 구성·Google Forms·Zoom·Gmail Flow 작업에서 함께 사용하는 Windows 데스크톱 플랫폼입니다.

## 사용자 설치

GitHub Releases에서 `CMOE-Workspace-Setup-0.9.0-Windows.exe`를 내려받아 실행합니다. 설치형은 바탕화면과 시작 메뉴에 바로가기를 만들며, 사용자 데이터는 프로그램 업데이트 후에도 유지됩니다.

## 개발 실행

```powershell
cd workspace
npm install
npm run desktop
```

`npm install`은 플랫폼 의존성과 Excel 처리 라이브러리를 함께 설치합니다.

## 검사와 Windows 설치 파일 빌드

```powershell
cd workspace
npm test
npm run smoke
npm run build:installer
```

완성된 설치 파일은 `workspace/desktop-dist`에 생성됩니다.

## 계정과 데이터

- 명단·템플릿·프로젝트 데이터는 기본적으로 Electron `userData` 폴더에 저장됩니다.
- 사용자가 선택하면 Google Drive 동기화를 사용할 수 있습니다.
- Google 및 Zoom 계정은 기능별로 별도 등록할 수 있습니다.
- OAuth 비밀번호·토큰은 Git 저장소에 저장하지 않습니다.

## 포함 구조

- 저장소 루트: Gmail Flow 확장 프로그램 및 데스크톱 모듈
- `workspace`: 전체 플랫폼
- `workspace/extensions`: 플랫폼에서 설치·활성화하는 기능 모듈 정의
