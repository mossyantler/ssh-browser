# 검증 결과 · v0.1.0 개발 버전

## 통과

- JavaScript 컨트롤러 테스트 **26개**: SOCKS/localhost 우회 설정 객체, 전환 직렬화, 서버 B 실패 시 A 유지, 프록시 정책 변경 감지, LOCAL/STOP 구분, 네이티브 이벤트/종료 상태, ID 유지와 가져오기 검증, 재시작 blocker, write-ahead pendingRemote, 롤백 실패와 정리·commit 중 종료 경합.
- macOS 설치/제거 회귀 테스트 **1개**: 임시 HOME만 사용, 등록 JSON 파싱, 바이너리 복사와 제거, SSH config 보존. 새 도우미 바이너리를 실행하지 않음.
- 합계 **27개 통과, 0개 실패, 네이티브 smoke 2개 건너뜀**. 이 결과는 실제 원격 연결 성공을 뜻하지 않음.
- UI 브라우저 수동 검증: 빈 초기 상태, SSH 별칭 Host 등록, 직접 입력 Host 등록(사용자 미입력 허용), 편집과 포트 변경, 즐겨찾기 전환, 검색, 그룹 필터, 삭제 확인과 삭제, 페이지 재로드 후 저장 유지.
- 빠른 전환 팝업: 저장된 Host 표시, 관리 화면 링크, 검색 입력, 미리보기 연결 버튼의 명시적 거부 확인.
- UI 미리보기는 실제 연결됨으로 표시하거나 프록시를 변경하지 않음. 시각 검증에 사용한 demo Host는 테스트 브라우저 localStorage에만 있고 배포판 초기 데이터에는 없음.
- 확장 JavaScript 구문, 셸 설치/제거/빌드 스크립트 구문 검증.
- Go 소스 gofmt, go vet, 테스트 바이너리 **컴파일만** 완료.
- macOS **darwin/arm64 및 darwin/amd64** 바이너리 빌드. 개발용 ad-hoc 서명. 빌드된 바이너리를 실행하지 않음.

## [blocked] 네이티브 실행 검증

macOS가 helper-unit.test를 차단하며 반복 경고를 표시해 실행을 중단했습니다. 해당 파일은 격리 속성과 ad-hoc 서명을 가진 개발 파일이고 Apple 공증은 없습니다. 사용자 보안 설정·격리 속성을 해제하거나 강제 실행하지 않았습니다.

미검증:
- Go runtime unit/race 테스트 실제 결과
- 실제 Chrome 확장 로드와 Native Messaging handshake
- 실제 원격 SSH 키/에이전트 인증
- 원격 localhost/127.0.0.1, HTTP/HTTPS, WebSocket와 인터넷 출구·DNS
- 실제 ProxyJump 자식 프로세스 종료 및 Intel 실행
- 실제 여러 Chrome 프로필/재시작/네트워크 장애 통합 동작

다음 단계: 사용자가 검토한 도우미를 macOS의 정식 정책에 따라 실행할 수 있는 개발/서명 환경을 마련하고, 지정한 테스트 SSH Host로 위 항목을 검증해야 합니다. 비밀번호나 개인키 내용은 전달할 필요가 없습니다. 정식 배포용 Apple Developer 서명/notarization은 별도 작업입니다.

## 테스트 실행 방법

```bash
# 안전한 기본 검사. 새 도우미 테스트 바이너리는 실행하지 않음.
node --test tests/*.mjs
bash scripts/build.sh
```

Native Messaging 실행 smoke 테스트는 SSH_BROWSER_NATIVE_TESTS=1로 명시적으로 켜도록 분리했습니다. Go 실행 테스트는 build.sh --run-tests로 별도 요청해야 실행됩니다. 차단된 환경에서는 켜지 마세요. 보안 차단을 우회하는 스크립트는 없습니다.

`tests/browser-integration.cjs`는 이후 Chrome for Testing + playwright-core 환경에서 확장 로드/Native Messaging/로컬 SOCKS 경로를 검사하기 위한 준비 코드입니다. 이번 검증에서는 **실행하지 않았고 그 스크립트 자체도 통합 검증 전**입니다. 다운로드한 테스트 브라우저도 실행하지 않았습니다.
