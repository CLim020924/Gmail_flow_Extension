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
3. OAuth 클라이언트 ID를 만들 때 Chrome 확장 프로그램 ID `chfahliclkpdeklinbplbadohncaejgo`를 등록합니다.
4. 발급된 클라이언트 ID를 `manifest.json`의 `oauth2.client_id`에 입력합니다.
5. `chrome://extensions`에서 확장 프로그램을 새로고침합니다.
6. 팝업 오른쪽 위 설정에서 `Gmail 연결`을 누르고 권한을 승인합니다.

현재 요청 범위는 `https://www.googleapis.com/auth/gmail.modify`이며 초안 생성·발송·라벨·예약 초안 처리에 사용됩니다.

## Chrome에 불러오기

1. Chrome에서 `chrome://extensions`를 엽니다.
2. 개발자 모드를 켭니다.
3. `압축해제된 확장 프로그램을 로드합니다`를 누릅니다.
4. 이 저장소 폴더를 선택합니다.

## 개발

빌드 과정이 없는 정적 Manifest V3 프로젝트입니다. 파일을 수정한 뒤 확장 프로그램 관리 화면에서 새로고침하면 됩니다.
