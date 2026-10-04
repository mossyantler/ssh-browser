# SSH Browser · macOS 개발 버전

Host를 등록하고 선택하면 작업용 Chrome 프로필의 웹 접속 경로를 SSH 서버로 전환하도록 구현한 확장과 도우미입니다. 아직 정식 배포판이 아닙니다.

> **현재 검증 한계:** UI와 JavaScript/설치 테스트 27개는 통과했습니다. Go 도우미는 Apple Silicon·Intel 빌드와 정적 검증만 완료했으며, 네이티브 실행은 macOS Gatekeeper 차단으로 보류했습니다. 실제 Chrome 확장 로드·Native Messaging·원격 SSH·localhost/인터넷 경로는 아직 통합 검증하지 않았습니다. 이 컴퓨터의 Chrome 프로필이나 도우미를 자동 설치하지 않았고, 보안 차단도 해제하지 않았습니다.

## GitHub 소스와 개발 ZIP

이 저장소는 **소스만** 제공합니다. 빌드된 실행 파일, 개인키, 로컬 설정과 임시 파일은 Git에 포함하지 않습니다.

GitHub에서 받은 경우 Go 1.22 이상이 설치된 개발 환경에서 먼저 빌드하세요. 기본 빌드 명령은 테스트를 컴파일만 하고 새 네이티브 테스트 파일을 실행하지 않습니다.

```bash
git clone https://github.com/mossyantler/ssh-browser.git
cd ssh-browser
bash scripts/build.sh
```

세션에서 제공한 개발 ZIP에는 미검증 Apple Silicon·Intel 바이너리가 포함되어 있어 빌드 단계 없이 설치할 수 있지만, 이 GitHub 저장소 자체에는 바이너리가 없습니다.

## 시작하기

1. Google Chrome에서 SSH 작업용 **새 프로필**을 만듭니다. Google 계정 로그인은 필요하지 않습니다.
2. 이 폴더를 영구 위치에 두세요. 확장 폴더를 옮기면 다시 로드해야 합니다.
3. 해당 프로필의 `chrome://extensions`에서 개발자 모드를 켜고 **압축해제된 확장 프로그램을 로드**를 눌러 `extension` 폴더를 선택합니다. ZIP 전체가 아니라 extension 폴더입니다.
4. 터미널에서 아래를 실행해 도우미를 **사용자 계정에만** 등록합니다. 관리자 권한은 필요하지 않습니다.

```bash
cd /path/to/ssh-browser
bash scripts/install-macos.sh
```

5. 기존 터미널에서 접속에 성공하는 SSH 별칭을 Host로 등록합니다. 또는 주소/포트/사용자와 기존 키 파일의 절대 경로를 등록합니다. 키 파일 내용을 붙여넣지 마세요.
6. 연결을 누릅니다. 팝업이 닫혀도 연결은 유지됩니다. 서버를 바꾸면 기존 페이지는 새로고침하세요.

## Aside에서 테스트하기

Aside의 `chrome://extensions`에서도 `extension` 폴더를 로드할 수 있습니다. 현재 설치 스크립트는 Chrome/Chromium용이며 Aside 옵션은 없습니다. 도우미를 Chrome용으로 등록한 뒤 아래 명령으로 Aside에도 등록 파일을 복사할 수 있습니다.

```bash
mkdir -p "$HOME/Library/Application Support/Aside/NativeMessagingHosts"
cp "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.sshbrowser.helper.json" \
   "$HOME/Library/Application Support/Aside/NativeMessagingHosts/"
```

UI 미리보기와 Aside의 확장 로드 화면·등록 폴더만 확인했습니다. 실제 Aside Native Messaging/SSH 연결은 미검증입니다. 메인 프로필에서 원격 모드를 사용하면 그 프로필의 일반 웹 탭과 localhost 대시보드 경로도 바뀔 수 있으므로 분리된 환경에서 먼저 테스트하세요. Gatekeeper 차단을 해제하는 명령은 제공하지 않습니다. Aside 등록을 제거하려면 이 도구의 연결을 끝내고 확장을 제거한 뒤 `~/Library/Application Support/Aside/NativeMessagingHosts/com.sshbrowser.helper.json`만 삭제하세요. 다른 도우미 등록 파일을 삭제하지 마세요.

## 인증과 안전성

- 기존 OpenSSH 키·SSH 에이전트만 지원합니다. 비밀번호, OTP, 대화형 키 암호 입력은 미지원입니다.
- 새로운 서버는 먼저 일반 SSH 접속으로 호스트키를 확인하고 known_hosts에 등록하세요. 이 도구는 호스트키 검증을 끄거나 자동 승인하지 않습니다.
- 기존 SSH 설정의 ProxyJump/ProxyCommand는 OpenSSH가 실행할 수 있으므로 신뢰하는 설정만 사용하세요. 확장에서 임의 SSH 옵션/셸 명령을 입력하는 기능은 없습니다.
- 도우미는 /usr/bin/ssh를 사용하고 SOCKS는 127.0.0.1에만 바인딩합니다. 기존 SSH master 공유와 백그라운드 분리를 끄고 도우미가 자기 프로세스를 관리하도록 합니다. 비밀정보는 확장에 저장하지 않습니다.
- 한 Chrome 프로필 안에서 Host를 바꿔도 쿠키와 로그인 데이터는 공유됩니다. 서버별 격리가 필요하면 Chrome 프로필도 나누세요. 동일 프로필의 모든 일반 창은 같은 경로를 사용합니다. 시크릿 모드는 지원하지 않습니다.
- SSH가 끊기면 자동으로 로컬 직접 연결로 전환하지 않습니다. 명시적 **로컬**은 DIRECT, **전환 끄기**는 이 확장의 프록시 설정만 해제해 원래 시스템/정책 설정을 사용합니다.
- Chrome 재시작 또는 도우미 종료 뒤에는 원격 상태를 다시 연결해야 합니다. UI가 과거 연결을 현재 연결로 표시하지 않도록 합니다.
- 웹 프록시 도구이지 시스템 VPN이 아닙니다. WebRTC/UDP 등 모든 트래픽을 보호하는 킬 스위치가 아니며, 확장을 끄거나 제거하면 원래 네트워크 설정이 적용됩니다.

## 설치·제거

개발 ZIP에는 Apple Silicon/Intel macOS 실행 파일이 bin에 포함되어 있습니다. GitHub 소스를 받은 경우 먼저 빌드해야 합니다. 개발용 ad-hoc 서명이며 Apple notarization은 하지 않았습니다. 다운로드한 실행 파일이 Gatekeeper로 차단되면 보안 정책을 임의로 비활성화하지 말고, 소스를 검토해 직접 빌드하거나 macOS의 공식 허용 절차를 사용하세요.

도우미 설치 위치: ~/Library/Application Support/SSH Browser/bin/ssh-browser-helper
Chrome 등록 위치: ~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.sshbrowser.helper.json

Chromium은 `bash scripts/install-macos.sh --browser chromium`을 사용할 수 있습니다. 다른 Chrome 프로필에도 같은 확장 폴더를 로드하면 도우미 등록은 공유하고 세션은 따로 사용합니다.

제거 전 연결을 해제하고 Chrome에서 확장을 제거한 뒤:

```bash
bash scripts/uninstall-macos.sh
```

사용자 SSH 키·config·known_hosts는 설치/제거 과정에서 변경하지 않습니다.

## 개발

UI/서비스 워커는 빌드 단계 없는 ES modules, 도우미는 Go 표준 라이브러리로 구현했습니다. 첫 기능 검증 버전은 npm 런타임 의존성이 없습니다. 확장 public key는 설치 경로가 달라도 ID를 유지하기 위한 것이며 개인키는 배포하지 않습니다.

```bash
# Go가 설치된 개발 환경: vet/테스트 컴파일/두 아키텍처 빌드만, 새 바이너리를 실행하지 않음
bash scripts/build.sh
# Node.js 20+ : 도우미 바이너리를 먼저 빌드. 네이티브 실행 테스트는 기본적으로 건너뜀
node --test tests/*.mjs
```

공통 메시지는 PROTOCOL.md, 검증 상태와 남은 항목은 TESTING.md를 보세요. Gatekeeper 문제를 사용자 확인 없이 우회하는 명령이나 동작은 포함하지 않았습니다. 실제 사용 전 도우미 실행과 원격 localhost·인터넷 경로를 확인해야 합니다.
