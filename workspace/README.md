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

GitHub Releases에서 `CMOE-Workspace-Setup-1.0.0-Windows.exe`를 내려받아 실행합니다. 설치형은 바탕화면과 시작 메뉴에 바로가기를 만들며, 사용자 데이터는 프로그램 업데이트 후에도 유지됩니다.

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
