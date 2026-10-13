'use strict';

// rtk proxy env NODE_PATH=/tmp/ssh-browser-test-tools/node_modules \
//   CHROME_TEST_BINARY='/path/to/Google Chrome for Testing' node tests/browser-integration.cjs
// Optional SSH_BROWSER_TEST_HELPER_APP='/absolute/path/SSH Browser Helper.app'
// Optional SSH_BROWSER_TEST_EXTENSION_DIR='/absolute/path/to/unpacked/extension'
// tests the bundled registration script; GUI first-launch registration is a separate check.
// Only temporary HOME/profile writes; no SSH connects or dependency installation.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const http = require('node:http');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const root = path.resolve(__dirname, '..');
const nativeHost = 'com.sshbrowser.helper';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function withTimeout(promise, ms, label = 'operation') {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    })]);
  } finally { clearTimeout(timer); }
}

async function assertState(session, status, { after = 0, timeout = 10000 } = {}) {
  // Require a runtime broadcast and its rendered UI, not merely a GET_STATE reply.
  await session.page.waitForFunction(({ status, after }) =>
    window.__sshBrowserTestEvents.slice(after).some(state => state.status === status) &&
    document.querySelector('#status-pill')?.dataset.status === status,
  { status, after }, { timeout });
  const reply = await session.call({ type: 'GET_STATE' });
  assert.equal(reply.ok, true, reply.error);
  assert.equal(reply.state.status, status);
  return reply.state;
}

async function assertProxyDirect(session) {
  const details = await session.page.evaluate(() => chrome.proxy.settings.get({ incognito: false }));
  assert.equal(details.value.mode, 'direct');
  assert.equal(details.levelOfControl, 'controlled_by_this_extension');
}

function assertResponse(session, reply, label) {
  if (reply?.ok === true) return reply;
  const codes = new Set(('NATIVE_UNAVAILABLE NATIVE_TIMEOUT NATIVE_LOST PROTOCOL PROXY_CONTROL UNCERTAIN_REMOTE INVALID_HOST HOST_IN_USE RETRY_EXHAUSTED RETRY_CANCELLED HOST_KEY AUTH TIMEOUT NETWORK SSH_EXIT SSH_CONNECT SSH_START CANCELLED LOCAL_PORT INTERNAL TUNNEL_LIMIT HELLO_REQUIRED ALREADY_INITIALIZED INVALID_TUNNEL UNKNOWN_COMMAND UNKNOWN').split(' '));
  const safeCode = value => codes.has(value) ? value : value == null ? null : 'UNKNOWN';
  const nativeErrors = new Set(['Specified native messaging host not found.',
    'Access to the specified native messaging host is forbidden.', 'Failed to start native messaging host.',
    'Native host has exited.', 'Error when communicating with the native messaging host.']);
  const state = reply?.state;
  const helper = {};
  for (const key of ['mode', 'nativePath', 'appSource', 'appCopy', 'registrationScript',
    'registrationExitCode', 'chromeManifestPath', 'cftManifestPath', 'profileManifestPath',
    'manifestSHA256', 'cftManifestSHA256', 'profileManifestSHA256', 'exactManifestCopy',
    'nativeSHA256', 'sourceHasSignatureResources', 'guiFirstLaunchChecked']) {
    const value = session.helper?.[key];
    if ((typeof value === 'string' && value.length <= 4096) || typeof value === 'boolean' || Number.isFinite(value)) helper[key] = value;
  }
  const diagnostics = { requestType: ['CHECK_HELPER', 'SAVE_HOST', 'DELETE_HOST', 'CONNECT', 'GET_STATE', 'LOCAL', 'STOP'].includes(label) ? label : 'UNKNOWN',
    ok: typeof reply?.ok === 'boolean' ? reply.ok : null, errorCode: safeCode(reply?.errorCode),
    nativeError: nativeErrors.has(reply?.error) ? reply.error : null,
    state: { status: ['disabled', 'local', 'connecting', 'connected', 'reconnecting', 'error'].includes(state?.status) ? state.status : null,
      helperAvailable: typeof state?.helperAvailable === 'boolean' ? state.helperAvailable : null,
      helperVersion: typeof state?.helperVersion === 'string' && /^[A-Za-z0-9.+_-]{1,64}$/.test(state.helperVersion) ? state.helperVersion : null,
      setupErrorCode: safeCode(state?.setupErrorCode), errorCode: safeCode(state?.errorCode) }, helper,
    extension: { directory: session.extensionDir, id: session.id } };
  // No entire state, hosts, generic error text, environment, SSH config or keys.
  const error = new Error(`Extension request failed: ${JSON.stringify(diagnostics)}`);
  error.diagnostics = diagnostics;
  throw error;
}

function prepareHelper({ home, profile, id }) {
  const appSource = process.env.SSH_BROWSER_TEST_HELPER_APP;
  const chromeManifestPath = path.join(home, 'Library/Application Support/Google/Chrome/NativeMessagingHosts', `${nativeHost}.json`);
  const cftManifestPath = path.join(home, 'Library/Application Support/Google/ChromeForTesting/NativeMessagingHosts', `${nativeHost}.json`);
  const profileManifestPath = path.join(profile, 'NativeMessagingHosts', `${nativeHost}.json`);
  if (appSource !== undefined) {
    assert.ok(path.isAbsolute(appSource) && appSource.endsWith('.app'), 'SSH_BROWSER_TEST_HELPER_APP must be an absolute .app path');
    assert.ok(fs.statSync(appSource).isDirectory(), 'helper app artifact must be a directory');
    const appCopy = path.join(home, 'Applications', 'SSH Browser Helper.app');
    fs.mkdirSync(path.dirname(appCopy), { recursive: true });
    const env = { ...process.env, HOME: home, CFFIXED_USER_HOME: home,
      XDG_CONFIG_HOME: path.join(home, '.config'), XDG_CACHE_HOME: path.join(home, '.cache') };
    const execute = (command, args, label) => {
      const result = spawnSync(command, args, { cwd: home, env, encoding: 'utf8',
        timeout: 30000, maxBuffer: 1024 * 1024 });
      if (result.error || result.status !== 0) throw new Error(`${label} failed (exit=${result.status}, signal=${result.signal}): ${result.error?.message || ''}\n${result.stderr || ''}\n${result.stdout || ''}`);
      return result;
    };
    // ditto retains bundle resources, extended attributes, ACLs and signatures.
    // No signing, xattr removal, Gatekeeper changes, or GUI app launch here.
    execute('/usr/bin/ditto', ['--rsrc', '--extattr', '--acl', appSource, appCopy], 'copy helper app');
    const binary = path.join(appCopy, 'Contents/MacOS/ssh-browser-native-host');
    assert.ok(fs.lstatSync(binary).isFile(), 'app native host must be its own regular executable, not an external symlink');
    fs.accessSync(binary, fs.constants.X_OK);
    const digest = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    const nativeSHA256 = digest(binary);
    assert.equal(nativeSHA256, digest(path.join(appSource, 'Contents/MacOS/ssh-browser-native-host')), 'ditto must preserve native executable bytes');
    const registrationScript = path.join(appCopy, 'Contents/Resources/scripts/register-helper-macos.sh');
    assert.equal(digest(registrationScript), digest(path.join(appSource, 'Contents/Resources/scripts/register-helper-macos.sh')), 'ditto must preserve the bundled registration script');
    const signatureResource = 'Contents/_CodeSignature/CodeResources';
    const sourceHasSignatureResources = fs.existsSync(path.join(appSource, signatureResource));
    if (sourceHasSignatureResources) assert.equal(digest(path.join(appCopy, signatureResource)), digest(path.join(appSource, signatureResource)), 'ditto must preserve existing signature resources');
    const registrationCommand = ['/bin/bash', registrationScript, '--app', appCopy, '--browser', 'chrome', '--extension-id', id];
    const registration = execute(registrationCommand[0], registrationCommand.slice(1), 'bundled helper registration');
    // The app's own generator is authoritative. Never synthesize an app manifest.
    const bytes = fs.readFileSync(chromeManifestPath);
    const manifest = JSON.parse(bytes);
    assert.equal(manifest.name, nativeHost);
    assert.equal(manifest.type, 'stdio');
    assert.ok(typeof manifest.path === 'string' && path.isAbsolute(manifest.path), 'generated native path must be absolute');
    assert.equal(fs.realpathSync(manifest.path), fs.realpathSync(binary), 'generated manifest must launch the copied app native host');
    assert.deepEqual(manifest.allowed_origins, [`chrome-extension://${id}/`]);
    // Test adaptation only: Chrome for Testing 146+ has its own host location;
    // production registration is Chrome's generated JSON, copied byte for byte.
    // Host locations: https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging#native-messaging-host-location
    // --user-data-dir overrides the user-level search root. App-mode repro:
    // HOME manifests alone => host not found; the exact profile copy => hello OK.
    for (const destination of [cftManifestPath, profileManifestPath]) {
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(chromeManifestPath, destination);
      assert.ok(bytes.equals(fs.readFileSync(destination)), 'test adaptation must preserve exact generated JSON');
    }
    return { binary: manifest.path, helper: { mode: 'app', nativePath: manifest.path, appSource, appCopy,
      registrationScript, registrationCommand, registrationExitCode: registration.status,
      chromeManifestPath, cftManifestPath, profileManifestPath, manifestSHA256: digest(chromeManifestPath),
      cftManifestSHA256: digest(cftManifestPath), profileManifestSHA256: digest(profileManifestPath), exactManifestCopy: true,
      nativeSHA256, sourceHasSignatureResources, guiFirstLaunchChecked: false } };
  }
  const binary = path.join(root, 'bin', `ssh-browser-helper-darwin-${process.arch === 'arm64' ? 'arm64' : 'amd64'}`);
  fs.accessSync(binary, fs.constants.X_OK);
  const manifest = { name: nativeHost, description: 'isolated test helper', path: binary,
    type: 'stdio', allowed_origins: [`chrome-extension://${id}/`] };
  for (const file of [profileManifestPath, chromeManifestPath, cftManifestPath]) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(manifest));
  }
  return { binary, helper: { mode: 'legacy', nativePath: binary } };
}

async function withIsolatedBrowser(run) {
  const browserPath = process.env.CHROME_TEST_BINARY;
  if (!browserPath) throw new Error('Set CHROME_TEST_BINARY to a Chrome for Testing executable.');
  if (process.platform !== 'darwin') throw new Error('These Native Messaging integration tests currently target macOS.');
  fs.accessSync(browserPath, fs.constants.X_OK);
  const { chromium } = require('playwright-core');
  const extensionOverride = process.env.SSH_BROWSER_TEST_EXTENSION_DIR;
  if (extensionOverride !== undefined) assert.ok(path.isAbsolute(extensionOverride), 'SSH_BROWSER_TEST_EXTENSION_DIR must be absolute');
  const extensionDir = extensionOverride === undefined ? path.join(root, 'extension') : extensionOverride;
  assert.ok(fs.statSync(extensionDir).isDirectory(), 'extension directory must exist');
  const id = fs.readFileSync(path.join(extensionDir, 'ID.txt'), 'utf8').trim();
  assert.match(id, /^[a-p]{32}$/);
  const manifestBytes = fs.readFileSync(path.join(extensionDir, 'manifest.json'));
  const extensionManifest = JSON.parse(manifestBytes);
  assert.ok(typeof extensionManifest.key === 'string' && /^[A-Za-z0-9+/]+={0,2}$/.test(extensionManifest.key), 'extension manifest must contain its public key');
  const expectedId = createHash('sha256').update(Buffer.from(extensionManifest.key, 'base64')).digest('hex').slice(0, 32)
    .replace(/[0-9a-f]/g, digit => String.fromCharCode(97 + parseInt(digit, 16)));
  assert.equal(id, expectedId, 'extension ID must match the loaded manifest public key');
  const extension = { mode: extensionOverride === undefined ? 'source' : 'artifact', directory: extensionDir,
    id, manifestSHA256: createHash('sha256').update(manifestBytes).digest('hex') };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-browser-chrome-'));
  const home = path.join(tmp, 'home'), profile = path.join(tmp, 'profile');
  let browser, context, page, child, childError, session, failure, result;
  let output = '';
  const cleanupErrors = [];
  try {
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(profile, { recursive: true });
    const { binary, helper } = prepareHelper({ home, profile, id });
    const args = [
      `--user-data-dir=${profile}`, '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1',
      '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
      '--disable-component-update', '--disable-sync', '--disable-default-apps',
      '--password-store=basic', '--use-mock-keychain', '--enable-unsafe-extension-debugging',
      '--disable-features=DisableLoadExtensionCommandLineSwitch',
      `--disable-extensions-except=${extensionDir}`,
      `--load-extension=${extensionDir}`,
      ...(process.env.SSH_BROWSER_TEST_HEADED === '1' ? [] : ['--headless=new']), 'about:blank',
    ];
    // Normal launch only. Never re-sign, clear quarantine, alter security, or use regular Chrome as fallback.
    // Track the child we actually spawn; never discover/kill Chrome or SSH by PID/name guesses.
    child = spawn(browserPath, args, { cwd: tmp, detached: true, stdio: ['ignore', 'ignore', 'pipe'],
      env: { ...process.env, HOME: home, CFFIXED_USER_HOME: home,
        XDG_CONFIG_HOME: path.join(home, '.config'), XDG_CACHE_HOME: path.join(home, '.cache'),
        CHROME_CONFIG_HOME: path.join(home, '.config') } });
    child.on('error', error => { childError = error; });
    child.stderr.on('data', chunk => { output = (output + chunk).slice(-8000); });
    let endpoint;
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      if (childError) throw childError;
      if (child.exitCode !== null || child.signalCode !== null)
        throw new Error(`Chrome normal launch failed (exit=${child.exitCode}, signal=${child.signalCode}). No security bypass attempted.\n${output}`);
      try {
        const [port, wsPath] = fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').trim().split('\n');
        if (/^\d+$/.test(port) && wsPath?.startsWith('/devtools/browser/')) {
          endpoint = `ws://127.0.0.1:${port}${wsPath}`; break;
        }
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      await sleep(100);
    }
    if (!endpoint) throw new Error(`Chrome normal launch/DevTools startup timeout. No security bypass attempted.\n${output}`);
    browser = await chromium.connectOverCDP(endpoint, { timeout: 10000 });
    context = browser.contexts()[0]; // Regular default context, not incognito/newContext().
    assert.ok(context, 'regular Chrome context must exist');
    context.setDefaultTimeout(10000); context.setDefaultNavigationTimeout(15000);
    let worker = context.serviceWorkers().find(worker => worker.url().startsWith(`chrome-extension://${id}/`));
    if (!worker) worker = await context.waitForEvent('serviceworker', {
      predicate: worker => worker.url().startsWith(`chrome-extension://${id}/`), timeout: 15000,
    });
    assert.equal(worker.url(), `chrome-extension://${id}/background.js`);
    page = await withTimeout(context.newPage(), 10000, 'create extension page');
    await page.goto(`chrome-extension://${id}/options.html`);
    await withTimeout(page.evaluate(() => {
      window.__sshBrowserTestEvents = [];
      chrome.runtime.onMessage.addListener((message, sender) => {
        if (message?.type === 'STATE_CHANGED' && sender.id === chrome.runtime.id)
          window.__sshBrowserTestEvents.push(message.state);
      });
    }), 10000, 'register STATE_CHANGED observer');
    session = { context, page, worker, tmp, home, profile, id, binary, helper, browser, extensionDir, extension,
      call: msg => withTimeout(page.evaluate(msg => chrome.runtime.sendMessage(msg), msg), 30000, msg.type),
      stateEvents: () => withTimeout(page.evaluate(() => window.__sshBrowserTestEvents.slice()), 10000, 'read STATE_CHANGED events') };
    result = await withTimeout(run(session), 120000, 'browser test session');
  } catch (error) { failure = error; }
  finally {
    if (session && !page.isClosed()) {
      for (const type of ['LOCAL', 'STOP']) {
        try {
          const reply = await withTimeout(session.call({ type }), 6000, `cleanup ${type}`);
          assertResponse(session, reply, type);
          if (type === 'LOCAL') await withTimeout(assertProxyDirect(session), 3000, 'cleanup direct verification');
          else {
            const details = await withTimeout(page.evaluate(() => chrome.proxy.settings.get({ incognito: false })), 3000, 'cleanup proxy verification');
            assert.notEqual(details.levelOfControl, 'controlled_by_this_extension');
          }
        } catch (error) { cleanupErrors.push(error); }
      }
    }
    if (browser) {
      try { await withTimeout(browser.close(), 5000, 'browser.close'); }
      catch (error) { cleanupErrors.push(error); }
    }
    if (child?.pid) {
      // Also clean descendants if the tracked parent has already exited. This is
      // the group created by detached spawn, never a discovered/guessed SSH PID.
      const signalGroup = signal => {
        try { process.kill(-child.pid, signal); return true; }
        catch (error) { if (error.code !== 'ESRCH') cleanupErrors.push(error); return false; }
      };
      if (signalGroup('SIGTERM')) {
        const deadline = Date.now() + 3000;
        while (Date.now() < deadline) {
          try { process.kill(-child.pid, 0); } catch (error) { if (error.code !== 'ESRCH') cleanupErrors.push(error); break; }
          await sleep(100);
        }
        signalGroup('SIGKILL');
      }
      if (child.exitCode === null && child.signalCode === null) {
        try { await withTimeout(new Promise(resolve => child.once('exit', resolve)), 3000, 'Chrome forced exit'); }
        catch (error) { cleanupErrors.push(error); }
      }
    }
    child?.stderr?.destroy(); child?.unref();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  if (failure || cleanupErrors.length) {
    const errors = [failure, ...cleanupErrors].filter(Boolean);
    const error = new AggregateError(errors, `Browser integration failed: ${errors.map(item => item.message).join('; ')}`);
    if (failure?.report) error.report = failure.report;
    throw error;
  }
  return result;
}

function trackedServer(server) {
  const sockets = new Set();
  server.on('connection', socket => { sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket)); });
  return { server, sockets,
    listen: () => withTimeout(new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(server.address().port); });
    }), 5000, 'server.listen'),
    close: async () => {
      for (const socket of sockets) socket.destroy();
      if (server.listening) await withTimeout(new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())), 3000, 'server.close');
    } };
}

async function nativeHello(page) {
  return page.evaluate(() => new Promise((resolve, reject) => {
    const port = chrome.runtime.connectNative('com.sshbrowser.helper');
    const replies = [];
    let settled = false;
    const finish = (error, result) => {
      if (settled) return; settled = true; clearTimeout(timer); port.disconnect();
      error ? reject(error) : resolve(result);
    };
    const timer = setTimeout(() => finish(new Error('Native Messaging hello timed out')), 5000);
    port.onDisconnect.addListener(() => {
      const detail = chrome.runtime.lastError?.message;
      if (!settled) finish(new Error(detail || 'Unexpected native disconnect'));
    });
    port.onMessage.addListener(reply => {
      replies.push(reply);
      if (reply.ok !== true) return finish(new Error(JSON.stringify(reply.error)));
      if (reply.requestId === 'hello') port.postMessage({ type: 'status', requestId: 'status' });
      if (reply.requestId === 'status') finish(null, replies);
    });
    port.postMessage({ type: 'hello', requestId: 'hello', protocol: 1, profileId: 'browser-integration' });
  }));
}

async function runLocal() {
  return withIsolatedBrowser(async session => {
    const { page, context, call } = session;
    let requests = 0, rejectSOCKS = false;
    const routed = [], upstream = new Set();
    const target = trackedServer(http.createServer((req, res) => {
      requests++; res.setHeader('Cache-Control', 'no-store'); res.setHeader('Connection', 'close');
      res.end('SSH_BROWSER_PROXY_TEST');
    }));
    let socks;
    try {
      const initial = await call({ type: 'GET_STATE' });
      assert.equal(initial.ok, true); assert.equal(initial.state.status, 'disabled');
      assert.deepEqual(initial.state.hosts, []);
      assertResponse(session, await call({ type: 'CHECK_HELPER' }), 'CHECK_HELPER');
      await page.waitForFunction(() => window.__sshBrowserTestEvents.some(state => state.helperAvailable === true) &&
        document.querySelector('#setup-status')?.textContent.includes('도우미 사용 가능'));
      const native = await withTimeout(nativeHello(page), 7000, 'native hello/status');
      assert.equal(native[0].result.protocol, 1); assert.deepEqual(native[1].result.tunnels, []);
      const host = { id: 'integration-test', name: '테스트 Host', mode: 'alias', alias: 'integration-test', group: '테스트', favorite: true, port: 22 };
      assert.equal((await call({ type: 'SAVE_HOST', host })).ok, true);
      await page.waitForFunction(() => document.querySelector('#host-grid')?.textContent.includes('테스트 Host'));
      assert.equal((await call({ type: 'DELETE_HOST', id: host.id })).ok, true);
      assert.deepEqual((await call({ type: 'GET_STATE' })).state.hosts, []);
      const localMark = (await session.stateEvents()).length;
      assert.equal((await call({ type: 'LOCAL' })).ok, true);
      await assertState(session, 'local', { after: localMark }); await assertProxyDirect(session);
      const httpPort = await target.listen();
      socks = trackedServer(net.createServer(socket => {
        let buffer = Buffer.alloc(0), phase = 'greeting';
        const parse = chunk => {
          buffer = Buffer.concat([buffer, chunk]);
          if (phase === 'greeting') {
            if (buffer.length < 2 || buffer.length < 2 + buffer[1]) return;
            if (buffer[0] !== 5 || !buffer.subarray(2, 2 + buffer[1]).includes(0)) return socket.destroy();
            buffer = buffer.subarray(2 + buffer[1]);
            if (rejectSOCKS) { socket.end(Buffer.from([5, 255])); return; }
            socket.write(Buffer.from([5, 0])); phase = 'request';
          }
          if (phase !== 'request' || buffer.length < 5) return;
          let host, offset;
          if (buffer[3] === 1) { offset = 8; if (buffer.length < 10) return; host = [...buffer.subarray(4, 8)].join('.'); }
          else if (buffer[3] === 3) { offset = 5 + buffer[4]; if (buffer.length < offset + 2) return; host = buffer.subarray(5, offset).toString(); }
          else return socket.destroy();
          const port = buffer.readUInt16BE(offset);
          // The fake proxy can reach only this test's HTTP fixture, never arbitrary local ports.
          if (buffer[0] !== 5 || buffer[1] !== 1 || !['localhost', '127.0.0.1'].includes(host) || port !== httpPort) return socket.destroy();
          routed.push({ host, port }); phase = 'stream'; socket.removeListener('data', parse); socket.pause();
          const pending = buffer.subarray(offset + 2);
          const connection = net.connect({ host: '127.0.0.1', port }, () => {
            socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
            if (pending.length) connection.write(pending);
            socket.pipe(connection); connection.pipe(socket); socket.resume();
          });
          upstream.add(connection);
          connection.on('error', () => socket.destroy());
          connection.on('close', () => { upstream.delete(connection); socket.destroy(); });
          socket.on('close', () => connection.destroy());
        };
        socket.on('data', parse);
      }));
      const socksPort = await socks.listen();
      // Routing fixture is separate from CONNECT: no SSH or mocked controller state.
      assert.equal((await call({ type: 'STOP' })).ok, true);
      await page.evaluate(port => chrome.proxy.settings.set({ value: { mode: 'fixed_servers', rules: {
        singleProxy: { scheme: 'socks5', host: '127.0.0.1', port }, bypassList: ['<-loopback>'],
      } }, scope: 'regular' }), socksPort);
      const routePage = await context.newPage();
      for (const hostName of ['127.0.0.1', 'localhost']) {
        const response = await routePage.goto(`http://${hostName}:${httpPort}/route-${hostName}`);
        assert.equal(response.status(), 200); assert.equal(await routePage.textContent('body'), 'SSH_BROWSER_PROXY_TEST');
        assert.ok(routed.some(route => route.host === hostName && route.port === httpPort));
      }
      // Hold the owned port while refusing SOCKS; no port-9 assumption or bind race.
      rejectSOCKS = true;
      for (const socket of socks.sockets) socket.destroy();
      for (const socket of upstream) socket.destroy();
      const before = requests;
      for (const hostName of ['127.0.0.1', 'localhost']) {
        await assert.rejects(routePage.goto(`http://${hostName}:${httpPort}/blocked-${Date.now()}`, { timeout: 5000 }),
          /ERR_SOCKS_CONNECTION_FAILED|ERR_PROXY_CONNECTION_FAILED|ERR_CONNECTION_CLOSED/);
        assert.equal(requests, before, 'failed SOCKS must never fall back to direct localhost');
      }
      const stopMark = (await session.stateEvents()).length;
      assert.equal((await call({ type: 'STOP' })).ok, true);
      await assertState(session, 'disabled', { after: stopMark });
      assert.notEqual((await page.evaluate(() => chrome.proxy.settings.get({ incognito: false }))).levelOfControl, 'controlled_by_this_extension');
      assert.equal((await call({ type: 'LOCAL' })).ok, true); await assertState(session, 'local');
      assert.equal((await routePage.goto(`http://localhost:${httpPort}/explicit-local`)).status(), 200);
      await assertProxyDirect(session);
      let screenshot;
      if (process.env.SSH_BROWSER_TEST_SCREENSHOT === '1') {
        screenshot = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-browser-screenshot-')), 'options.png');
        await page.screenshot({ path: screenshot, fullPage: true });
      }
      return { extensionLoaded: true, nativeMessaging: true, checkHelper: true, hostCRUD: true,
        stateChangedUI: true, localDirect: true, localhostThroughSOCKS: true, ipv4ThroughSOCKS: true,
        failedSOCKSBlocked: true, explicitLocalRecovery: true, stopRestoresUnderlying: true,
        chrome: session.browser.version(), helper: session.helper, extension: session.extension, ...(screenshot ? { screenshot } : {}),
        notChecked: ['realSSH', 'boundedRecovery', 'unexpectedOwnedHelperTermination'] };
    } finally {
      for (const socket of upstream) socket.destroy();
      const closed = await Promise.allSettled([socks?.close(), target.close()]);
      const failures = closed.filter(item => item.status === 'rejected').map(item => item.reason);
      if (failures.length) throw new AggregateError(failures, 'Local fixture cleanup failed');
    }
  });
}

module.exports = { withIsolatedBrowser, assertState, assertProxyDirect, withTimeout, assertResponse };
if (require.main === module) runLocal().then(result => console.log(JSON.stringify(result, null, 2))).catch(error => {
  console.error(error); process.exitCode = 1;
});
