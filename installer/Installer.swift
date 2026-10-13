import AppKit

private final class HelperDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate {
    private var window: NSWindow!
    private let status = NSTextField(wrappingLabelWithString: "Chrome에 등록하고 있어요…")
    private let details = NSTextView()
    private let retry = NSButton(title: "등록 다시 시도", target: nil, action: nil)
    private var isRunning = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        let menu = NSMenu()
        let item = NSMenuItem()
        item.submenu = NSMenu()
        item.submenu?.addItem(withTitle: "SSH Browser Helper 종료",
                             action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        menu.addItem(item)
        NSApp.mainMenu = menu
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 480, height: 310),
                          styleMask: [.titled, .closable, .miniaturizable], backing: .buffered, defer: false)
        window.title = "SSH Browser Helper"
        window.delegate = self
        window.center()
        let stack = NSStackView()
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 12
        stack.translatesAutoresizingMaskIntoConstraints = false
        let content = window.contentView!
        content.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 24),
            stack.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -24),
            stack.topAnchor.constraint(equalTo: content.topAnchor, constant: 22)
        ])
        status.font = .systemFont(ofSize: 17, weight: .semibold)
        stack.addArrangedSubview(status)
        let scroll = NSScrollView()
        scroll.hasVerticalScroller = true
        details.isEditable = false
        details.font = .systemFont(ofSize: 12)
        details.textContainerInset = NSSize(width: 4, height: 4)
        details.isHorizontallyResizable = false
        details.autoresizingMask = [.width]
        details.textContainer?.widthTracksTextView = true
        details.setAccessibilityLabel("Chrome 등록 상태와 오류")
        scroll.documentView = details
        stack.addArrangedSubview(scroll)
        scroll.heightAnchor.constraint(equalToConstant: 120).isActive = true
        retry.target = self
        retry.action = #selector(register)
        retry.bezelStyle = .rounded
        retry.isHidden = true
        stack.addArrangedSubview(retry)
        let notice = NSTextField(wrappingLabelWithString: "개발용 ad-hoc 서명 앱 · Apple notarization(공증)을 받지 않았어요.")
        notice.font = .systemFont(ofSize: 11)
        notice.textColor = .secondaryLabelColor
        stack.addArrangedSubview(notice)
        for view in [status, scroll, notice] {
            view.translatesAutoresizingMaskIntoConstraints = false
            view.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        }
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        register()
    }

    private func validLocation(_ app: URL, home: URL) -> Bool {
        let original = app.standardizedFileURL
        let resolved = original.resolvingSymlinksInPath()
        let forbidden = ["Downloads", "AppTranslocation", "Volumes"]
        guard original.pathExtension == "app", resolved.pathExtension == "app",
              !forbidden.contains(where: { original.pathComponents.contains($0) || resolved.pathComponents.contains($0) }),
              (try? resolved.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true else { return false }
        return [URL(fileURLWithPath: "/Applications", isDirectory: true),
                home.appendingPathComponent("Applications", isDirectory: true)].contains { root in
            let root = root.standardizedFileURL
            guard let attributes = try? FileManager.default.attributesOfItem(atPath: root.path),
                  attributes[.type] as? FileAttributeType == .typeDirectory else { return false }
            let canonical = root.resolvingSymlinksInPath().pathComponents
            let insideOriginalRoot = original.pathComponents.count > root.pathComponents.count
                && original.pathComponents.starts(with: root.pathComponents)
            let insideCanonicalRoot = original.pathComponents.count > canonical.count
                && original.pathComponents.starts(with: canonical)
            return (insideOriginalRoot || insideCanonicalRoot)
                && resolved.pathComponents.count > canonical.count
                && resolved.pathComponents.starts(with: canonical)
        }
    }

    @objc private func register() {
        guard !isRunning else { return }
        retry.isHidden = true
        let configuredHome = ProcessInfo.processInfo.environment["HOME"]
        if let path = configuredHome, !path.hasPrefix("/") || path.contains("\0") {
            status.stringValue = "HOME 경로를 확인해 주세요"
            details.string = "HOME은 절대 경로여야 해요. 올바른 HOME으로 앱을 다시 열어 주세요."
            return
        }
        let home = configuredHome.map { URL(fileURLWithPath: $0, isDirectory: true) }
            ?? FileManager.default.homeDirectoryForCurrentUser
        let app = Bundle.main.bundleURL
        guard validLocation(app, home: home) else {
            status.stringValue = "앱을 Applications로 옮겨 주세요"
            details.string = "SSH Browser Helper.app을 /Applications 또는 ~/Applications로 옮긴 뒤 다시 열어 주세요.\nDownloads, 디스크 이미지, AppTranslocation 및 링크로 우회한 위치에서는 등록하지 않아요."
            return
        }
        guard let resources = Bundle.main.resourceURL else {
            finish(success: false, output: "앱의 Resources 폴더가 없어요.")
            return
        }
        let script = resources.appendingPathComponent("scripts/register-helper-macos.sh")
        let nativeHost = app.appendingPathComponent("Contents/MacOS/ssh-browser-native-host")
        guard FileManager.default.isReadableFile(atPath: script.path),
              FileManager.default.isReadableFile(atPath: resources.appendingPathComponent("extension-id.txt").path),
              FileManager.default.isExecutableFile(atPath: nativeHost.path) else {
            finish(success: false, output: "필수 등록 파일이 없어요. 완전한 SSH Browser Helper.app을 다시 받아 주세요.")
            return
        }
        isRunning = true
        status.stringValue = "Chrome에 등록하고 있어요…"
        details.string = "등록이 끝날 때까지 기다려 주세요."
        let environment = ["HOME": configuredHome ?? home.path, "PATH": "/usr/bin:/bin:/usr/sbin:/sbin"]
        DispatchQueue.global(qos: .userInitiated).async {
            let pipe = Pipe()
            defer { try? pipe.fileHandleForReading.close(); try? pipe.fileHandleForWriting.close() }
            var output = Data()
            var success = false
            let process = Process()
            do {
                process.executableURL = URL(fileURLWithPath: "/bin/bash")
                process.arguments = [script.path, "--app", app.path]
                process.environment = environment
                process.currentDirectoryURL = resources
                process.standardInput = FileHandle.nullDevice
                process.standardOutput = pipe
                process.standardError = pipe
                try process.run()
                try? pipe.fileHandleForWriting.close()
                // Drain continuously; retain only 8 KiB, without a log file or pipe-buffer deadlock.
                while let chunk = try pipe.fileHandleForReading.read(upToCount: 4096), !chunk.isEmpty {
                    output.append(chunk.prefix(max(0, 8192 - output.count)))
                }
                process.waitUntilExit()
                success = process.terminationReason == .exit && process.terminationStatus == 0
                output.append(Data("\n종료 코드: \(process.terminationStatus)".utf8))
            } catch {
                try? pipe.fileHandleForReading.close()
                if process.isRunning { process.waitUntilExit() }
                output = Data("등록을 실행하지 못했어요: \(error.localizedDescription)".utf8)
            }
            let message = String(decoding: output, as: UTF8.self)
            let succeeded = success
            DispatchQueue.main.async { self.finish(success: succeeded, output: message) }
        }
    }

    private func finish(success: Bool, output: String) {
        isRunning = false
        retry.isHidden = success
        status.stringValue = success ? "Chrome 도우미 등록 완료" : "Chrome 등록 실패"
        details.string = success
            ? "Chrome Native Messaging 등록이 끝났어요. SSH 연결은 브라우저 확장에서 시작해 주세요. 이 창은 닫아도 돼요."
            : "오류를 확인한 뒤 등록을 다시 시도해 주세요.\n\(output)"
    }

    func windowShouldClose(_ sender: NSWindow) -> Bool { !isRunning }
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        isRunning ? .terminateCancel : .terminateNow
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}

let application = NSApplication.shared
private let delegate = HelperDelegate()
application.delegate = delegate
application.run()
