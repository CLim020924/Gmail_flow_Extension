# CMOE Workspace 1.14.8 복구·통합 릴레이

기준일: 2026-11-12  
작업 브랜치: `codex/restore-cmoe-workspace-1.14.8`  
기준 설치본: `C:/Users/user/Desktop/cmoe작업/설문조사로직/CMOE-Workspace-Setup-1.14.8-Windows.exe`

## 복구 기준

- 제품명: CMOE Workspace
- 설치본 파일 버전: `1.14.8`
- 크기: `113,683,351` bytes
- SHA-256: `DD6FD1F95FCB9969AE7536D4A45C04BAF8DC47C69B7ED6A2E119C1F48D8B7A7E`
- Windows 서명: `NotSigned`
- 복구 방법: 설치하지 않고 NSIS 페이로드와 `resources/app.asar`를 정적으로 추출한다.
- 식별자·사용자 데이터 위치·OAuth 자료는 변경하지 않는다.

## 확인된 문제

기존 GitHub 브랜치의 Workspace 최신 소스는 1.2.0 계열이며, 사용자가 마지막으로 사용한 1.14.8보다 오래되었다. 잘못된 기준에서 만든 1.3.0은 기능 추가판이 아니라 사실상 다운그레이드다.

정적 비교 결과:

- 1.14.8 화면 ID 757개, 기존 Git 소스 314개
- 기존 Git 소스에 없는 1.14.8 화면 ID 462개
- 독립 문서 편집, 전체/프로젝트 캘린더, 완전한 Forms 편집, 가이드, 고급 가져오기·로그인·시간대 UI와 관련 백엔드가 빠져 있다.

## 반드시 보존할 1.14.8 기능군

- 명단·작업표·일정표의 Excel식 편집과 우클릭 셀 작업
- 프로젝트 명단, 단계·반별 명단, 공용 명단 연동
- 일정 자동 편성, 사람 중심 재조정, 프로젝트·전체 캘린더
- Google Forms 질문 편집, 템플릿, 미리보기, 가져오기·복사
- Zoom 및 Gmail Flow 연동
- 문서 변환, 합치기, 나누기, Excel 중복 정리·비교
- PPTX 템플릿 기반 문서 일괄 생성과 명단 연결
- 가이드 라이브러리와 단계별 화면 안내
- 계정 브라우저 선택, 시간대, 가져오기 미리보기와 진행률
- 시작 실패·네트워크 제한·인증정보 보호·웹 콘텐츠 보안 처리

## 이번 통합에서 추가할 항목

- 예약발송 실행 방식 선택 제거
- 모든 신규 예약발송을 Apps Script 온라인 큐로 등록
- Gmail 초안을 먼저 생성하고, Apps Script 시간 트리거가 발송
- 기존 로컬 예약 기록은 삭제하지 않고 보존
- 1.14.8 UI를 재배치하거나 축소하지 않고 연결 설정만 기존 설정 화면에 추가
- 설치 유지관리 화면, 사용자 데이터 유지, 검증형 앱 업데이트
- 버전은 `1.14.8`보다 높은 숫자로 발행

## 복구 소스 매핑

- `app.asar` 루트 → `workspace/` UI·핵심 소스
- `app.asar/desktop` → `workspace/desktop/`
- `app.asar/extensions` → `workspace/extensions/`
- `resources/gmail-flow` → 루트 Gmail Flow와 비교 후 선별 복구
- `resources/office-tools` → 문서 처리용 패키징 리소스
- `resources/browser-tools` → 브라우저 선택용 패키징 리소스
- `resources/vendor/node_modules` → 잠금 파일과 비교 검증용이며 그대로 Git에 커밋하지 않음

## 작업 체크리스트

- [x] 기준 설치본 메타데이터·해시 확인
- [x] NSIS와 `app.asar` 정적 추출
- [x] Git 원격 브랜치·태그에 1.14.8 소스가 없음을 확인
- [x] 복구 전용 브랜치 생성
- [x] 1.14.8 소스와 리소스 복원
- [x] 패키징 설정·의존성 재구성
- [x] 1.14.8 원본 기능 스모크 기준 복구
- [x] 온라인 단일 예약발송 이식
- [x] 설치 유지관리·앱 업데이트 이식
- [x] 기능·DOM·IPC·패키징 리소스 전수 대조
- [x] 개발 스모크·통합 테스트·패키징 검증
- [x] 설치형·휴대형 결과와 SHA-256 기록
- [x] Git 커밋 생성 (`c09f5b9`)
- [x] 원격 브랜치 `origin/codex/restore-cmoe-workspace-1.14.8` 푸시

## 아직 검증하지 않은 항목

- 실제 Google 계정의 Apps Script 시간 트리거 도달 발송은 계정 승인 후 별도 검증이 필요하다.
- 외부 Windows PC에서 1.14.8 위에 1.15.1을 설치하는 대화형 업데이트는 아직 실행하지 않았다.
- Windows 코드 서명 인증서가 없어 두 EXE는 `NotSigned`이다.
- Cresero 운영 업데이트 피드와 다운로드 페이지 게시는 이번 요청 범위에서 수행하지 않았다.

## 복구·통합 분석 결과

- 추출한 1.14.8 `app.asar` 기준 복원 누락 파일: 0개
- 원본과 달라진 핵심 파일: `workspace/app.js`, `workspace/index.html`, `workspace/desktop/main.js`, `workspace/desktop/preload.js`
- 위 4개는 예약발송 설정·앱 업데이트 UI/IPC를 의도적으로 추가한 파일이다.
- `office-tools` 4개, `browser-tools` 1개는 설치본 페이로드와 해시가 모두 일치한다.
- 개발 Electron 스모크: 통과. Forms, 계정 로그인, 프로젝트 달력, 문서 변환·분할·편집, PPTX, 일정·명단·Gmail, 가이드 11개/215단계를 확인했다.
- Workspace·Gmail Flow·Apps Script 통합 테스트: 전체 통과.
- 패키징 사전검사: ExcelJS 4.4.0, 문서/달력 확장, OAuth 릴리스 설정, 온라인 예약 클라이언 모두 통과.
- 패키지 `app.asar`에 문서 편집기, 프로젝트 달력, 업데이터, Google OAuth 릴리스 설정이 포함되었고 Gmail Flow 리소스에 온라인 예약 클라이언이 포함되었다.

## 1.15.0 산출물

| 종류 | 경로 | 크기 | SHA-256 | 서명 |
|---|---|---:|---|---|
| 설치형 | `workspace/desktop-dist/CMOE-Workspace-Setup-1.15.0-Windows.exe` | 111,025,537 bytes | `2887F5014867AA893F87E1D59075DC52363F3E646CFAE6110E0168082370A83C` | NotSigned |
| 휴대형 | `workspace/desktop-dist/CMOE-Workspace-1.15.0-Windows.exe` | 92,633,314 bytes | `6CB6C1F950799730B98E79ECB6731FD1E333BB279E7B21078E03BA1E3C6E38B2` | NotSigned |

## 1.15.1 업데이트·중복 처리 보강

- 업데이트 피드 버전과 GitHub 릴리스 폴더·설치 파일명이 정확히 일치해야 다운로드한다.
- 다운로드 중 취소할 수 있고, 취소·오류 시 `.partial` 파일을 제거한다.
- 보조 프로세스가 시작 PID의 실행 경로를 정확히 확인한 뒤 종료를 기다린다.
- 설치 직전 파일 크기와 SHA-256을 다시 검증하고, 설치 후 EXE `FileVersion`이 예정 버전과 일치할 때만 한 번 재실행한다.
- 설치 관리자는 설치 경로에 속한 제거기만 실행하며, 등록 정보가 손상되면 임의의 명령을 실행하지 않는다.
- 프로그램 바로가기는 같은 경로의 기존 파일을 교체하고 구 명칭 바로가기를 정리해 중복을 남기지 않는다.
- Electron 단일 인스턴스 잠금과 두 번째 실행의 기존 창 복원·포커스 동작을 유지한다.

| 종류 | 경로 | 크기 | SHA-256 | 서명 |
|---|---|---:|---|---|
| 설치형 | `workspace/desktop-dist/CMOE-Workspace-Setup-1.15.1-Windows.exe` | 111,026,029 bytes | `F88786853B179EEEA01C3FFE39BD4A6D5276CC2C41BF54ED61D1592F32EDF4B0` | NotSigned |
| 휴대형 | `workspace/desktop-dist/CMOE-Workspace-1.15.1-Windows.exe` | 92,636,346 bytes | `28B923D0480E323F08A6938BD2DC72D0055E3FDEB0C6A74EE968023DEFCCB986` | NotSigned |

## 다음 작업자 릴레이 목록

1. 실제 Google 계정에서 Apps Script 웹 앱을 배포하고 Gmail 발신 계정 일치·예약 도달 발송·취소·상태 동기화를 확인한다.
2. 분리된 Windows 테스트 PC/VM에 1.14.8을 먼저 설치하고 1.15.1 업데이트·제거·재시작·사용자 데이터 보존을 검증한다.
3. 코드 서명 인증서를 준비한 후 두 EXE에 서명하고 SmartScreen 표시를 외부 PC에서 확인한다.
4. 사용자의 명시적 배포 요청 후에만 GitHub Release, Cresero 다운로드, `update.json`을 1.15.1 해시와 함께 게시한다.
5. 게시 후 다운로드 본이 로컬 산출물과 크기·SHA-256이 일치하는지 재검증한다.
