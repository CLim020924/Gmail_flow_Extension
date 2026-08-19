# CMOE 전체 플랫폼 브랜치

이 브랜치는 기존 Gmail Flow와 CMOE Workspace 전체 플랫폼을 함께 제공합니다.

- Gmail Flow만 개발하려면 저장소 루트의 기존 명령을 사용합니다.
- 전체 플랫폼을 실행하거나 설치 파일로 만들려면 `workspace/README.md`를 따릅니다.
- 배포용 Windows 설치 파일은 Git 커밋에 넣지 않고 GitHub Releases에 첨부합니다.

## 빠른 시작

```powershell
cd workspace
npm install
npm run desktop
```

## 설치 파일 만들기

```powershell
cd workspace
npm run build:installer
```
