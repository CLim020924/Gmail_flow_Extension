# Gmail Flow Extension

사용자 정의 명단, 변수, 메일 템플릿, Gmail 초안·발송·예약·기록 기능을 제공하는 Chrome 확장 프로그램입니다.

## 현재 구현 범위

- 사용자 정의 컬럼과 `{컬럼명}` 대상별 치환
- 수신자별 실제 제목·본문 미리보기
- Excel/CSV/탭/복수 공백 표 붙여넣기와 컬럼 자동 생성
- 명단·명단 템플릿·메일 템플릿 저장, 상세 조회, 이름 변경, 삭제
- 저장 명단과 사용 중인 메일 템플릿 연결
- Gmail API 실제 초안 생성, 즉시 발송, 예약 초안 및 예약 발송
- 수신자 없는 Gmail 초안 생성
- 최대 3회 재시도, 한 번에 40건 처리하는 영속 작업 큐
- 작업 기록과 대상별 실제 치환 메시지·오류 조회
- 기록 삭제와 진행 중 작업 취소

## Gmail OAuth 설정

실제 Gmail 작업을 실행하기 전에 개발자가 한 번 설정해야 합니다.

1. Google Cloud Console에서 프로젝트를 만들고 Gmail API를 활성화합니다.
2. OAuth 동의 화면을 구성합니다. 테스트 상태라면 사용할 Google 계정을 테스트 사용자로 추가합니다.
3. OAuth 클라이언트 ID를 만들 때 개발자 모드에 표시되는 Chrome 확장 프로그램 ID를 등록합니다.
4. 발급된 개발용 클라이언트 ID를 `manifest.json`의 `oauth2.client_id`에 입력합니다. 웹 스토어용 ID를 이 파일에 직접 넣으면 개발자 모드 로그인이 실패합니다.
5. `chrome://extensions`에서 확장 프로그램을 새로고침합니다.
6. 팝업 오른쪽 위 설정에서 `Gmail 연결`을 누르고 권한을 승인합니다.

현재 요청 범위는 `https://www.googleapis.com/auth/gmail.modify`이며 초안 생성·발송·라벨·예약 초안 처리에 사용됩니다.

## Chrome에 불러오기

1. Chrome에서 `chrome://extensions`를 엽니다.
2. 개발자 모드를 켭니다.
3. `압축해제된 확장 프로그램을 로드합니다`를 누릅니다.
4. 이 저장소 폴더를 선택합니다.

## Chrome 웹 스토어 배포

이 확장 프로그램은 검색에 노출되지 않고 링크를 아는 사용자만 설치할 수 있는 `미등록(Unlisted)` 배포를 기준으로 합니다.

1. Chrome 웹 스토어 개발자 대시보드에서 개발자 계정을 등록합니다.
2. 배포 ZIP을 새 항목으로 업로드하되, 처음에는 심사를 제출하지 않습니다.
3. 생성된 웹 스토어 항목의 확장 프로그램 ID를 확인합니다.
4. Google Cloud에서 해당 ID용 `Chrome 확장 프로그램` OAuth 클라이언트를 만듭니다. 현재 웹 스토어 ID는 `lgepaiahgdmaempfplpfgmgjiiobohnf`입니다.
5. `./build-webstore.ps1`을 실행합니다. 이 스크립트는 개발용 `manifest.json`을 변경하지 않고 웹 스토어용 OAuth 클라이언트를 넣은 `dist/Gmail-Flow-v버전-webstore.zip`을 만듭니다.
6. 생성된 ZIP을 업로드한 뒤 스토어 등록정보와 개인정보 보호 항목을 작성합니다.
7. 배포 공개 상태를 `미등록(Unlisted)`으로 설정하고 심사를 제출합니다.

`미등록`은 검색·카테고리에서 발견되지 않지만 링크 전달 자체를 막지는 않습니다. 승인된 계정만 설치하게 제한하려면 공개 상태를 `비공개(Private)`로 설정하고 Google 그룹 또는 허용 사용자를 구성해야 합니다.

웹 스토어용 설명과 권한 답변 초안은 `STORE_LISTING.md`, 개인정보처리방침은 `PRIVACY.md`에 있습니다.

## 개발

빌드 과정이 없는 정적 Manifest V3 프로젝트입니다. 파일을 수정한 뒤 확장 프로그램 관리 화면에서 새로고침하면 됩니다.

일반 사용자의 Windows·macOS Chrome은 웹 스토어 밖의 ZIP/CRX 원클릭 설치를 허용하지 않습니다. 검토 전에 공유해야 한다면 저장소를 ZIP으로 전달하고 사용자가 압축을 푼 뒤 개발자 모드에서 직접 불러와야 합니다. 조직에서 관리하는 브라우저라면 Chrome Enterprise 정책을 통한 강제 설치를 사용할 수 있습니다.

검토 전 외부 테스터에게 전달할 패키지는 `./build-tester.ps1`로 만듭니다. 결과물은 `dist/Gmail-Flow-v버전-tester.zip`이며 고정 확장 ID `edmpcifdaknahhchkmipankimonidldo`와 전용 OAuth 클라이언트를 사용합니다. ZIP 내부의 `INSTALL-KO.txt`에 설치 및 Gmail 연결 방법이 포함됩니다.

## Windows 데스크톱 앱

Electron 기반 Windows 앱은 기존 확장 프로그램 UI와 메일 작업 로직을 공유합니다. 앱 전용 저장소, Google 데스크톱 OAuth(PKCE), Windows DPAPI 토큰 암호화, 트레이 상주 작업 큐를 사용합니다.

```powershell
npm install
npm run build:windows
```

결과물은 `desktop-dist/Gmail-Flow-버전-Windows.exe`입니다. 휴대용 실행 파일이므로 별도 설치 없이 더블클릭하면 바로 실행됩니다. 창을 닫으면 트레이에 남아 예약 작업을 처리하며, 트레이 메뉴의 `종료`를 선택하면 완전히 종료됩니다. 컴퓨터가 꺼져 있거나 앱이 완전히 종료된 동안에는 예약 발송을 처리할 수 없습니다.
