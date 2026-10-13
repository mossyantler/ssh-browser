# SSH Browser · macOS 개발 버전

등록한 Host를 선택해 Chrome 프로필의 웹 접속을 SSH 서버의 SOCKS5 터널로 전환하는 확장과 도우미예요. Host 관리와 빠른 전환 화면에는 로컬에 포함한 Primer CSS를 사용해요. 버전은 0.1.0이며 기존 확장 ID를 유지해요.

## 시작하기

도우미 앱과 Chrome 확장은 별도 배포해요. 무료 ad-hoc 서명 배포이며 Apple notarization은 하지 않았어요. 다운로드한 앱은 macOS의 실행 정책에 따라 경고가 표시되거나 차단될 수 있어요. Go·Node.js나 터미널 명령은 사용자 설치에 필요하지 않아요.

1. macOS 14 이상에서 `SSH-Browser-Helper-macos-universal.dmg`를 열고 `SSH Browser Helper.app`을 함께 보이는 **Applications** 링크로 드래그하세요. ZIP을 쓰려면 `SSH-Browser-Helper-macos-universal.zip`을 풀어 앱을 `/Applications` 또는 `~/Applications`로 옮기세요. 옮긴 위치에서 앱을 한 번 정상 실행하면 Chrome Native Messaging 도우미 등록이 자동으로 완료돼요.
2. 앱 창을 닫아도 돼요. 이후에는 확장에서 도우미가 필요할 때 Chrome이 앱 안의 Native Messaging host를 시작해요. 앱에는 Chrome 확장이 포함되지 않아요.
3. `SSH-Browser-Extension.zip`을 별도로 받아 압축을 풀고 계속 사용할 폴더에 두세요. Chrome의 SSH 작업용 프로필에서 `chrome://extensions`를 열고 개발자 모드를 켠 뒤 **압축해제된 확장 프로그램을 로드**에서 `manifest.json`이 있는 확장 폴더를 선택하세요.
4. 확장 팝업 또는 호스트 관리 화면에서 **도우미 설치 확인**을 누르세요. 응답이 없으면 Helper.app을 옮긴 위치에서 한 번 실행했는지 확인하고 Chrome을 다시 열어 확인하세요.
5. Host를 추가하고 연결하세요. 기존 SSH 별칭 또는 주소·포트·사용자·기존 키 파일의 절대 경로를 입력해요. 개인키 내용이나 비밀번호를 붙여넣지 마세요. 서버를 바꾼 뒤 기존 페이지는 새로고침하세요.

기존 확장을 사용하는 경우에는 현재 로드한 확장 폴더를 업데이트하고 Reload하세요. 확장을 제거하거나 중복 추가하지 마세요. Helper.app의 첫 실행은 Chrome 도우미 등록을 앱 안의 Native Messaging host 경로로 갱신해요. 이전 도우미 바이너리는 삭제하지 않고 사용하지 않게 돼요. 확장 파일의 복사·제거·이전은 하지 않아요. 앱을 다른 위치로 옮겼다면 새 위치에서 다시 실행해 등록 경로를 갱신하세요.

최종 Helper.app과 별도 Extension ZIP은 격리된 Chrome for Testing에서 로컬·oracle 원격 통합 검증을 통과했어요. 실제 Naver HTTPS 200·NAVER 제목과 연결·해제를 확인했으며 GUI 최초 실행 등록도 별도로 검증했어요. 개인 Chrome 프로필 적용과 남은 검증 범위는 [TESTING.md](TESTING.md)를 참고하세요.

## 연결과 인증

기존 OpenSSH 키·SSH 에이전트를 사용해요. 비밀번호, OTP, 대화형 키 암호 입력은 지원하지 않아요. 새 서버의 호스트키는 먼저 일반 SSH 접속에서 확인하세요. SSH 별칭의 ProxyJump·ProxyCommand는 OpenSSH가 실행하므로 신뢰하는 기존 설정을 사용하세요.

도우미는 `/usr/bin/ssh`를 실행하고 SOCKS를 `127.0.0.1`에만 바인딩해요. SSH master 공유와 백그라운드 분리를 꺼서 자신의 터널 프로세스를 관리해요. 확장에 개인키 내용이나 비밀번호를 저장하지 않아요.

한 Chrome 프로필의 쿠키와 로그인 데이터는 Host를 바꿔도 공유돼요. 서버별 격리가 필요하면 프로필을 나누세요. 동일 프로필의 일반 창은 같은 경로를 사용하며 시크릿 모드는 지원하지 않아요. 원격 모드에서는 localhost도 SSH 서버 쪽 경로를 사용해요.

연결 중 일시적인 SSH·도우미 장애가 발생하거나 저장된 원격 모드로 재시작하면 원격 경로를 차단한 상태에서 최대 3회 재연결을 시도해요. 대기 간격은 1·3·8초이며 재시작해도 저장된 시도 횟수를 유지해요. 인증·호스트키 오류와 프록시 제어 충돌은 자동 재시도하지 않아요. 최초 수동 연결의 실패도 자동 재시도를 시작하지 않아요. 실패해도 자동으로 로컬 직접 연결로 바꾸지 않아요.

**로컬 직접 연결**은 예약된 재시도를 취소하고 DIRECT로 전환해요. **프록시 제어 해제**는 재시도를 취소하고 이 확장의 프록시 설정만 해제해 원래 시스템·정책 설정을 사용해요. 다른 Host를 직접 선택하면 이전 재시도를 취소해요.

웹 프록시 도구이며 시스템 VPN은 아니에요. WebRTC·UDP를 포함한 모든 트래픽을 보호하는 기능은 없어요. 확장을 끄거나 제거하면 원래 네트워크 설정이 적용돼요.

## 개발

Go 1.22 이상과 Node.js 20 이상을 사용해요. 도우미는 Go 표준 라이브러리로 구현했고 Primer CSS는 확장 안에 포함해 외부 CDN을 사용하지 않아요. 저장소를 받은 뒤 해당 폴더에서 실행하세요.

```bash
rtk git clone https://github.com/mossyantler/ssh-browser.git
rtk proxy npm ci
rtk npm run vendor:primer:check
rtk proxy bash scripts/build.sh
rtk proxy node --test tests/*.mjs
```

기본 빌드는 Go vet·테스트 컴파일·Apple Silicon/Intel 도우미 빌드만 수행해요. Go 실행 테스트는 `--run-tests`로 분리돼 있어요. 전체 Node 검사와 앱 패키징에는 macOS의 Swift compiler와 Apple command line tools가 필요해요. Native Messaging과 원격 SSH 검사는 기본적으로 건너뛰어요.

Primer 파일을 재생성하려면 `rtk npm run vendor:primer`를 사용하세요. 패키징은 기존에 빌드한 두 아키텍처의 helper를 사용해요.

```bash
rtk proxy bash scripts/package-macos.sh --skip-helper
```

기본 출력 폴더는 `installer/dist/standalone-final/`이에요. 도우미 앱만 담은 `SSH-Browser-Helper-macos-universal.zip`과 별도 `SSH-Browser-Extension.zip`을 생성해요. 선택적 DMG는 앱을 Applications로 옮기는 용도예요. 실제 산출물 경로는 패키징 명령의 출력에서 확인하세요. 빌드 실행 파일과 배포 산출물은 Git에 포함하지 않아요.

`scripts/install-macos.sh`·`scripts/uninstall-macos.sh`는 개발용 도우미 등록·해제 경로예요. 기존 확장 파일과 설정은 유지해요. 현재 사용자 배포 흐름은 Helper.app의 최초 실행 등록과 별도 확장 로드예요.

메시지 계약은 [PROTOCOL.md](PROTOCOL.md), 실행 명령과 검증 범위는 [TESTING.md](TESTING.md)를 참고하세요. 확장 public key는 ID를 유지하기 위한 값이며 개인키는 배포하지 않아요.
