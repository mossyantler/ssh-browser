# SSH Browser 검증

## 현재 배포 흐름

`SSH Browser Helper.app`을 `/Applications` 또는 `~/Applications`로 옮겨 한 번 정상 실행하면 Chrome Native Messaging 등록을 갱신해요. 앱은 도우미만 포함하며 확장은 `SSH-Browser-Extension.zip`으로 별도 배포해요. 앱 창을 닫은 뒤에도 Chrome이 필요할 때 Native Messaging host를 시작해요. 기존 확장·설정·이전 도우미 바이너리는 삭제하거나 이전하지 않아요.

배포물은 `installer/dist/standalone-final/`의 Helper.app·DMG·도우미 ZIP·`SSH-Browser-Extension.zip`이에요. 독립 검증에서 arm64/x86_64의 strict/deep ad-hoc 서명, 도우미 ZIP의 byte·mode 일치와 CRC, 확장 ZIP 14개 파일·ID의 현재 소스 일치를 확인했어요. DMG는 앱과 Applications 링크만 포함하며 read-only 검증 후 detach했어요. 무료 ad-hoc 배포이며 notarization은 하지 않았어요.

실제 GUI를 임시 HOME의 Applications에 복사해 한 번 실행한 결과 Chrome 등록 JSON의 canonical path·origin이 일치했어요. 등록 완료 안내와 창을 닫아도 된다는 안내를 확인했고, 창 종료 후 앱 PID는 종료되며 manifest는 유지됐어요. Applications 밖에서 실행하면 이동 안내만 표시하고 실제 manifest는 변경하지 않는 것도 확인했어요.

현재 선택한 Node 검사 158개는 전부 통과했어요(실패 0개·skip 0개). 컨트롤러·재연결·UI·빌드·개발용 CLI·앱 등록을 포함해요. packaging fixture 검사 1개도 별도로 통과했어요.

최종 Helper.app과 최종 Extension ZIP을 압축 해제한 폴더로 두 브라우저 runner를 실행해 모두 exit 0으로 통과했어요. 로컬 검사는 확장 로드·Native Messaging·CHECK_HELPER·Host CRUD·STATE_CHANGED/UI, LOCAL 직접 연결, localhost·IPv4 SOCKS 경유, SOCKS 실패 시 차단, 명시적 LOCAL 복구와 STOP 후 원래 설정 복원을 확인했어요. oracle 원격 검사는 CHECK_HELPER·CONNECT·이벤트/UI, fixed_servers SOCKS와 `<-loopback>`, Naver HTTPS 200·NAVER 제목, LOCAL·STOP을 확인했어요.

검증은 개인 Chrome 프로필이 아닌 격리된 Chrome for Testing 154.0.8037.92에서 수행했어요. 앱의 `Contents/MacOS/ssh-browser-native-host`를 사용했고 앱이 생성한 Chrome 등록 JSON을 CFT·임시 프로필에 byte-for-byte 복사해 세 파일의 SHA256 일치를 확인했어요. GUI 최초 실행 검증은 위에 기록한 별도 실제 실행 결과예요.

새 설치 안내 문자열을 반영한 UI 상태 테스트는 16개 통과했고 구문 검사도 통과했어요. 테스트 fixture·버튼·스타일·동작은 변경하지 않았어요.

## 이전 소스에서 확인한 결과

분리 배포 변경 전 Go 1.27.1 unit/race, Native smoke 2개, Chrome for Testing의 로컬·oracle 원격 경로가 통과했어요. 별도 Native 원격 smoke도 Naver HTTPS 200과 release·disconnect·EOF 이후 소유 프로세스 cleanup을 확인했어요. 이 결과는 새 앱의 최초 실행 등록과 Chrome 연동 검증을 대신하지 않아요.

## 기본 검사와 빌드

Node.js 20 이상과 Go 1.22 이상을 사용해요. Primer 생성·검사에는 `npm ci`, macOS packaging 검사에는 Swift compiler와 Apple command line tools가 필요해요. 저장소 루트에서 실행하세요.

```bash
rtk proxy npm ci
rtk npm run vendor:primer:check
rtk proxy node --test tests/*.mjs
rtk proxy bash scripts/build.sh
```

기본 빌드는 Go vet·테스트 컴파일·arm64/amd64 빌드예요. Go runtime 검사는 `rtk proxy bash scripts/build.sh --run-tests`, race 검사는 helper 디렉토리에서 `rtk go test -race ./...`로 실행해요. 기본 Node 검사는 원격 SSH에 접속하지 않아요.

## Native Messaging과 원격 검사

현재 Mac 아키텍처의 `bin/ssh-browser-helper-darwin-arm64` 또는 `bin/ssh-browser-helper-darwin-amd64`를 먼저 빌드하세요. 원격 runner는 Node 표준 라이브러리와 macOS SSH·curl만 사용해요.

```bash
rtk proxy env SSH_BROWSER_NATIVE_TESTS=1 node --test tests/native-smoke.mjs
rtk proxy node --test tests/remote-smoke.mjs
rtk proxy env SSH_BROWSER_REMOTE_TESTS=1 SSH_BROWSER_TEST_HOST=oracle node --test tests/remote-smoke.mjs
```

원격 smoke는 두 opt-in 환경변수가 모두 있어야 실행해요. 별도 helper에서 connect·status, `curl --socks5-hostname`, release·disconnect·EOF 이후 소유 터널 정리를 검사해요. 기본 대상은 `https://www.naver.com/`이며 출력은 curl 반환코드·HTTP status·timing뿐이에요. `SSH_BROWSER_TEST_URLS`로 최대 4개의 HTTP/HTTPS loopback 경로를 추가할 수 있어요. credentials·query·fragment·비밀 path는 넣지 마세요. localhost는 SSH 서버 쪽 localhost예요.

`tests/browser-integration.cjs`와 `tests/browser-remote.cjs`는 임시 Chrome for Testing 프로필의 로컬·원격 경로를 확인해요. `playwright-core`와 `CHROME_TEST_BINARY`가 필요하며 기본 Node suite에 포함되지 않아요. `SSH_BROWSER_TEST_HELPER_APP`으로 실제 앱을, `SSH_BROWSER_TEST_EXTENSION_DIR`로 최종 Extension ZIP에서 압축 해제한 확장 폴더를 선택해요. 두 경로 모두 절대 경로여야 해요.

```bash
rtk proxy env NODE_PATH=/tmp/ssh-browser-test-tools/node_modules \
  CHROME_TEST_BINARY='/absolute/path/to/Google Chrome for Testing' \
  SSH_BROWSER_TEST_HELPER_APP='/absolute/path/to/SSH Browser Helper.app' \
  SSH_BROWSER_TEST_EXTENSION_DIR='/absolute/path/to/unpacked/extension' \
  node tests/browser-integration.cjs
rtk proxy env SSH_BROWSER_REMOTE_TESTS=1 SSH_BROWSER_TEST_HOST=oracle \
  NODE_PATH=/tmp/ssh-browser-test-tools/node_modules \
  CHROME_TEST_BINARY='/absolute/path/to/Google Chrome for Testing' \
  SSH_BROWSER_TEST_HELPER_APP='/absolute/path/to/SSH Browser Helper.app' \
  SSH_BROWSER_TEST_EXTENSION_DIR='/absolute/path/to/unpacked/extension' \
  node tests/browser-remote.cjs
```

같은 원격 명령에 `SSH_BROWSER_BENCH=1`을 더하면 연결 후 캐시를 끈 상태로 NAVER를 순차 3회, 병렬 탭 6개로 열어 페이지 TTFB·load 시간과, CDP Network 이벤트로 잰 모든 요청의 대기(소켓 대기 포함)·연결·TTFB·다운로드 시간(p50/p95), 요청 수, 새 연결 수, HTTP/1.1 요청 수, 전송 바이트를 숫자로만 report의 `benchmark`에 남겨요. 병렬에서 대기만 크게 늘면 프록시 소켓 한도, 처리량이 회선 한계에 붙어 있으면 대역폭 병목으로 판단해요. `connectionDurationMs`도 함께 기록돼요. 라우팅 변경 전후 같은 네트워크에서 비교해 주세요.

hello 성공만으로 원격 경로가 검증되지는 않아요. 소스 바이너리·임시 브라우저 검사도 사용자 앱의 최초 실행 등록을 대신하지 않아요. 이번 배포 패키지의 실제 실행 결과는 통합 담당자가 제공한 증거를 기준으로 반영해요.

## 남은 실제 환경 확인

개인 Chrome 프로필에서의 최종 배포 적용과 실제 장애에서의 자동 재연결·helper 종료·브라우저 재시작 복구는 미검증이에요. 여러 프로필·ProxyJump·Intel 실행·원격 localhost·WebSocket·인터넷 출구·DNS도 별도 runtime 확인이 필요해요. 제한 재연결의 3회·1/3/8초 예약과 LOCAL·STOP·Host 변경 취소는 unit test 범위예요.
