'use strict';

// Deliberately excluded from the default tests/*.mjs suite. This contacts a real
// SSH host only when ALL three opt-in variables are present. Requiring this file
// has no side effects, and the shared browser harness is loaded after the gate.
// Run only after authorizing remote access:
// The optional SSH_BROWSER_TEST_HELPER_APP selects an app artifact; it does
// not enable remote tests. Omit that line to use the legacy helper.
// rtk proxy env SSH_BROWSER_REMOTE_TESTS=1 SSH_BROWSER_TEST_HOST=oracle \
//   CHROME_TEST_BINARY='/absolute/path/to/Chrome for Testing' \
//   SSH_BROWSER_TEST_HELPER_APP='/absolute/path/to/SSH Browser Helper.app' \
//   NODE_PATH=/tmp/ssh-browser-test-tools/node_modules node tests/browser-remote.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REQUEST_MS = 30000;
const UI_MS = 10000;
const NAVIGATION_MS = 30000;
const CLOSE_MS = 5000;
const ALIAS = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,252}$/;
const BENCH_URL = 'https://www.naver.com/';
const BENCH_ROUNDS = 3;
const BENCH_PARALLEL = 6;

// Runs inside the page. Only numbers leave the page: no URL, header or body.
// Cross-origin resources without Timing-Allow-Origin expose only duration, so
// queueing is summarized over the entries that expose request timing.
function pageTimings() {
  const [nav] = performance.getEntriesByType('navigation');
  const resources = performance.getEntriesByType('resource');
  const timed = resources.filter(entry => entry.requestStart > 0);
  const queued = timed.map(entry => Math.max(0, (entry.connectStart || entry.requestStart) - entry.fetchStart));
  const percentile = (values, p) => values.length ? values.slice().sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * p))] : null;
  return {
    ttfbMs: nav ? nav.responseStart - nav.requestStart : null,
    domContentLoadedMs: nav ? nav.domContentLoadedEventEnd - nav.startTime : null,
    loadMs: nav ? nav.loadEventEnd - nav.startTime : null,
    resources: resources.length, timedResources: timed.length,
    queueP50Ms: percentile(queued, 0.5), queueP95Ms: percentile(queued, 0.95),
    resourceDurationP95Ms: percentile(resources.map(entry => entry.duration), 0.95),
  };
}

// Network events expose per-request phases for every origin, unlike Resource
// Timing, which hides cross-origin detail without Timing-Allow-Origin.
// waitMs is queueing plus stalled time before the request reaches a socket:
// Chrome's per-proxy socket limit shows up there. Only numbers are kept.
function recordNetwork(cdp) {
  const issued = new Map(), requests = new Map();
  cdp.on('Network.requestWillBeSent', event => { if (/^https?:/.test(event.request.url)) issued.set(event.requestId, event.timestamp); });
  cdp.on('Network.responseReceived', event => {
    const timing = event.response.timing, issuedAt = issued.get(event.requestId);
    if (!timing || issuedAt === undefined) return;
    const firstStart = [timing.proxyStart, timing.dnsStart, timing.connectStart, timing.sendStart].find(value => value >= 0) ?? 0;
    requests.set(event.requestId, {
      waitMs: (timing.requestTime - issuedAt) * 1000 + firstStart,
      connectMs: timing.connectStart >= 0 ? timing.connectEnd - timing.connectStart : 0,
      ttfbMs: timing.receiveHeadersEnd - timing.sendEnd,
      headersAt: timing.requestTime + timing.receiveHeadersEnd / 1000,
      reused: event.response.connectionReused === true,
      http1: /^http\/1/i.test(event.response.protocol || ''),
    });
  });
  cdp.on('Network.loadingFinished', event => {
    const entry = requests.get(event.requestId);
    if (entry) { entry.downloadMs = Math.max(0, (event.timestamp - entry.headersAt) * 1000); entry.bytes = event.encodedDataLength; }
  });
  return () => [...requests.values()].filter(entry => entry.downloadMs !== undefined);
}
function summarize(entries) {
  const percentile = (values, p) => values.length ? Math.round(values.slice().sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * p))]) : null;
  const phase = key => ({ p50: percentile(entries.map(entry => entry[key]), 0.5), p95: percentile(entries.map(entry => entry[key]), 0.95) });
  return {
    requests: entries.length, newConnections: entries.filter(entry => !entry.reused).length,
    http1: entries.filter(entry => entry.http1).length, bytes: entries.reduce((sum, entry) => sum + (entry.bytes || 0), 0),
    waitMs: phase('waitMs'), connectMs: phase('connectMs'), ttfbMs: phase('ttfbMs'), downloadMs: phase('downloadMs'),
  };
}

// Opt-in browsing benchmark: sequential loads, then parallel tabs to expose
// per-proxy socket queueing. The HTTP cache is disabled so every load fetches
// the same work. Compare runs before and after routing changes.
async function browsingBenchmark(context, bounded) {
  const all = { sequential: [], parallel: [] };
  const load = async mode => {
    const page = await bounded(() => context.newPage(), UI_MS, 'create benchmark page');
    try {
      const cdp = await bounded(() => context.newCDPSession(page), UI_MS, 'benchmark CDP session');
      const collect = recordNetwork(cdp);
      await bounded(() => cdp.send('Network.enable'), UI_MS, 'enable network events');
      await bounded(() => cdp.send('Network.setCacheDisabled', { cacheDisabled: true }), UI_MS, 'disable cache');
      const started = Date.now();
      await bounded(() => page.goto(BENCH_URL, { waitUntil: 'load', timeout: NAVIGATION_MS }), NAVIGATION_MS + 1000, 'benchmark navigation');
      const wallMs = Date.now() - started;
      const timings = await bounded(() => page.evaluate(pageTimings), UI_MS, 'benchmark timings');
      const entries = collect();
      all[mode].push(...entries);
      return { wallMs, ttfbMs: timings.ttfbMs, loadMs: timings.loadMs, network: summarize(entries) };
    } finally {
      await bounded(() => page.close({ runBeforeUnload: false }), CLOSE_MS, 'close benchmark page').catch(() => {});
    }
  };
  const sequential = [];
  for (let round = 0; round < BENCH_ROUNDS; round++) sequential.push(await load('sequential'));
  const started = Date.now();
  const parallel = await Promise.all(Array.from({ length: BENCH_PARALLEL }, () => load('parallel')));
  return { rounds: BENCH_ROUNDS, sequential, parallelTabs: BENCH_PARALLEL, parallelWallMs: Date.now() - started, parallel,
    sequentialNetwork: summarize(all.sequential), parallelNetwork: summarize(all.parallel) };
}
function helperProvenance(helper) {
  const result = {};
  for (const key of ['mode', 'nativePath', 'appSource', 'appCopy', 'registrationScript',
    'registrationExitCode', 'chromeManifestPath', 'cftManifestPath', 'profileManifestPath', 'manifestSHA256',
    'cftManifestSHA256', 'profileManifestSHA256', 'exactManifestCopy', 'nativeSHA256', 'sourceHasSignatureResources', 'guiFirstLaunchChecked']) {
    const value = helper?.[key];
    if ((typeof value === 'string' && value.length <= 4096) || typeof value === 'boolean' || Number.isFinite(value)) result[key] = value;
  }
  if (Array.isArray(helper?.registrationCommand) && helper.registrationCommand.length <= 16 &&
    helper.registrationCommand.every(value => typeof value === 'string' && value.length <= 4096)) result.registrationCommand = helper.registrationCommand.slice();
  return result;
}

function remoteGate(env = process.env) {
  const missing = [];
  if (env.SSH_BROWSER_REMOTE_TESTS !== '1') missing.push('SSH_BROWSER_REMOTE_TESTS=1');
  if (!env.SSH_BROWSER_TEST_HOST?.trim()) missing.push('SSH_BROWSER_TEST_HOST');
  if (!env.CHROME_TEST_BINARY?.trim()) missing.push('CHROME_TEST_BINARY');
  return { enabled: missing.length === 0, missing };
}

function verifyOpenSSHHome(home) {
  // -G exits without connecting, -F /dev/null excludes user config and Match
  // exec, and CanonicalizeHostname=no prevents DNS canonicalization. A synthetic
  // IdentityAgent path tests OpenSSH's passwd-home expansion without opening
  // the agent, SSH config, known_hosts, or any key. Keep Chrome's temporary HOME.
  const probe = spawnSync('/usr/bin/ssh', [
    '-G', '-F', '/dev/null', '-o', 'CanonicalizeHostname=no',
    '-o', 'IdentityAgent=~/.ssh/ssh-browser-home-probe',
    '--', 'ssh-browser-home-check.invalid',
  ], {
    env: { ...process.env, HOME: home },
    encoding: 'utf8', timeout: CLOSE_MS, maxBuffer: 1024 * 1024,
  });
  if (probe.error) throw new Error(`OpenSSH HOME probe failed: ${probe.error.message}`);
  assert.equal(probe.status, 0, 'OpenSSH HOME probe must exit successfully');
  const actual = probe.stdout.split('\n').find(line => line.startsWith('identityagent '));
  const expected = path.join(os.userInfo().homedir, '.ssh', 'ssh-browser-home-probe');
  assert.equal(actual, `identityagent ${expected}`, 'OpenSSH must resolve ~ against passwd home while HOME is isolated');
  return true;
}

async function remoteSession(session, alias, { assertState, withTimeout, assertResponse }) {
  const { context, page, call, home, tmp } = session;
  assert.ok(context && page && typeof call === 'function', 'shared harness must provide a browser session');
  assert.ok(home && tmp && home !== os.userInfo().homedir, 'browser HOME must be temporary');
  const relativeHome = path.relative(tmp, home);
  assert.ok(relativeHome && !relativeHome.startsWith(`..${path.sep}`) && relativeHome !== '..' && !path.isAbsolute(relativeHome), 'browser HOME must be inside its temporary directory');
  const report = {
    suite: 'browser-remote', host: alias, passed: false,
    helper: helperProvenance(session.helper),
    checked: [],
    notChecked: ['boundedRecovery', 'unexpectedHelperTermination', 'restartRecovery',
      'remoteLocalhost', 'webSocket', 'egressIP', 'dnsLeak', 'intel', 'multipleProfiles'],
    limitations: [
      'No real helper/tunnel fault injection: bounded recovery and unexpected helper termination remain untested.',
      'No JS native-port mocks or guessed PID termination; only the harness owns and cleans up its spawned Chrome process.',
      'Uses existing SSH alias/config/keys without copying or editing them; the offline HOME probe is separate from remote authentication.',
    ],
  };
  let routePage;
  let failure;
  const cleanupErrors = [];

  // Use the shared bounded-promise helper, including for reads and page closes.
  // A timeout must never infer or signal an unrelated process ID.
  const bounded = (operation, timeout, label) => withTimeout(Promise.resolve().then(operation), timeout, label);
  const request = async (type, fields = {}) => {
    const response = await bounded(() => call({ type, ...fields }), REQUEST_MS, type);
    await assertResponse(session, response, type);
    return response;
  };
  const uiStatus = (status, after = 0) => bounded(
    () => assertState(session, status, { after, timeout: UI_MS }), UI_MS + 1000, `state/event/UI ${status}`,
  );
  const proxy = () => bounded(() => page.evaluate(() => new Promise((resolve, reject) => {
    chrome.proxy.settings.get({ incognito: false }, details => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message)); else resolve(details);
    });
  })), UI_MS, 'read Chrome proxy');
  const events = () => bounded(() => page.evaluate(() => globalThis.__sshBrowserRemoteEvents.slice()), UI_MS, 'read STATE_CHANGED events');

  try {
    verifyOpenSSHHome(home);
    report.checked.push('OpenSSH passwd-home expansion with isolated HOME (offline -G probe)');
    // Observe the real runtime broadcast in the extension's options page. No
    // service-worker/controller state is injected or replaced by this test.
    await bounded(() => page.evaluate(() => {
      globalThis.__sshBrowserRemoteEvents = [];
      chrome.runtime.onMessage.addListener((message, sender) => {
        if (message?.type === 'STATE_CHANGED' && sender.id === chrome.runtime.id && message.state) {
          globalThis.__sshBrowserRemoteEvents.push(message);
        }
      });
    }), UI_MS, 'observe runtime STATE_CHANGED');
    const helper = await request('CHECK_HELPER');
    assert.equal(helper.state?.helperAvailable, true);
    assert.ok(helper.state?.helperVersion, 'native hello must report a helper version');
    report.helperVersion = helper.state.helperVersion;
    report.checked.push('CHECK_HELPER through real Chrome Native Messaging');

    const host = {
      id: 'browser-remote-test', name: 'Remote integration test', mode: 'alias',
      alias, group: 'Integration tests', favorite: false,
      port: 22, user: '', address: '', keyPath: '',
    };
    const saved = await request('SAVE_HOST', { host });
    assert.ok(saved.state?.hosts.some(item => item.id === host.id && item.alias === alias));
    const eventStart = (await events()).length;
    const connected = await request('CONNECT', { id: host.id });
    assert.equal(connected.state?.status, 'connected');
    assert.equal(connected.state?.activeHostId, host.id);
    assert.equal(connected.state?.desiredMode, 'remote');
    assert.equal(connected.state?.proxyControlled, true);
    assert.ok(connected.state?.tunnelId, 'CONNECT must identify its live native tunnel');
    assert.ok(Number.isInteger(connected.state?.currentPort) && connected.state.currentPort > 0 && connected.state.currentPort <= 65535);
    await uiStatus('connected');
    const transitions = (await events()).slice(eventStart);
    const connectingIndex = transitions.findIndex(event => event.state.status === 'connecting');
    const connectedIndex = transitions.findIndex(event => event.state.status === 'connected' && event.state.activeHostId === host.id);
    assert.ok(connectingIndex >= 0 && connectedIndex > connectingIndex, 'actual STATE_CHANGED must publish connecting then connected');
    report.checked.push('CONNECT reply, actual STATE_CHANGED transitions, and #status-pill.dataset.status');

    const details = await proxy();
    assert.equal(details.levelOfControl, 'controlled_by_this_extension');
    assert.equal(details.value?.mode, 'fixed_servers');
    assert.deepEqual(details.value?.rules?.singleProxy, {
      scheme: 'socks5', host: '127.0.0.1', port: connected.state.currentPort,
    });
    assert.deepEqual(details.value?.rules?.bypassList, ['<-loopback>']);
    report.checked.push('Chrome fixed_servers SOCKS5 route and <-loopback> bypass setting');

    routePage = await bounded(() => context.newPage(), UI_MS, 'create HTTPS page');
    const response = await bounded(() => routePage.goto('https://www.naver.com/', {
      waitUntil: 'domcontentloaded', timeout: NAVIGATION_MS,
    }), NAVIGATION_MS + 1000, 'NAVER HTTPS navigation');
    assert.equal(response?.status(), 200, 'NAVER main document must return HTTP 200');
    assert.equal(new URL(routePage.url()).protocol, 'https:');
    assert.match(new URL(routePage.url()).hostname, /(^|\.)naver\.com$/i);
    const title = await bounded(() => routePage.title(), UI_MS, 'NAVER title');
    if (!/NAVER|네이버/i.test(title)) {
      const mainHeading = await bounded(() => routePage.locator('h1, main h2, main [role="heading"]').allTextContents(), UI_MS, 'NAVER main heading');
      assert.ok(mainHeading.some(text => /NAVER|네이버/i.test(text)), 'NAVER title or main heading must identify the site');
    }
    const stillConnected = await request('GET_STATE');
    assert.equal(stillConnected.state?.status, 'connected');
    assert.equal(stillConnected.state?.tunnelId, connected.state.tunnelId);
    assert.deepEqual(await proxy(), details, 'Chrome route must remain unchanged after HTTPS navigation');
    await uiStatus('connected');
    report.naver = { status: response.status(), title, url: routePage.url() };
    report.checked.push('Real Chrome NAVER HTTPS HTTP 200 and recognizable title/heading through the configured route');
    report.connectionDurationMs = connected.state.connectionDurationMs ?? null;
    if (process.env.SSH_BROWSER_BENCH === '1') {
      report.benchmark = await browsingBenchmark(context, bounded);
      report.checked.push('Opt-in browsing benchmark (numbers only)');
    }
  } catch (error) {
    failure = error;
  } finally {
    // Close network content first so explicit LOCAL cannot redirect its pending
    // subresources through the local route. Attempt STOP even if LOCAL fails.
    if (routePage) {
      try { await bounded(() => routePage.close({ runBeforeUnload: false }), CLOSE_MS, 'close HTTPS page'); }
      catch (error) { cleanupErrors.push(error); }
    }
    try {
      const local = await request('LOCAL');
      assert.equal(local.state?.status, 'local');
      assert.equal(local.state?.tunnelId, null);
      await uiStatus('local');
      const direct = await proxy();
      assert.equal(direct.value?.mode, 'direct');
      assert.equal(direct.levelOfControl, 'controlled_by_this_extension');
      report.checked.push('Explicit LOCAL cleanup, direct proxy, and local UI status');
    } catch (error) { cleanupErrors.push(error); }
    try {
      const stopped = await request('STOP');
      assert.equal(stopped.state?.status, 'disabled');
      assert.equal(stopped.state?.proxyControlled, false);
      assert.equal(stopped.state?.tunnelId, null);
      await uiStatus('disabled');
      assert.notEqual((await proxy()).levelOfControl, 'controlled_by_this_extension');
      report.checked.push('Explicit STOP cleanup, disabled UI status, and released Chrome proxy override');
    } catch (error) { cleanupErrors.push(error); }
    // The shared harness closes the owned Chrome context and removes only its
    // temporary manifest/HOME/profile. Never touch user profiles or infer PIDs.
  }
  if (failure || cleanupErrors.length) {
    const error = new AggregateError([failure, ...cleanupErrors].filter(Boolean),
      [failure, ...cleanupErrors].filter(Boolean).map(item => item.message).join('; '));
    error.report = report;
    throw error;
  }
  report.passed = true;
  return report;
}

async function main(env = process.env) {
  const gate = remoteGate(env);
  if (!gate.enabled) {
    const report = { suite: 'browser-remote', skipped: true, missing: gate.missing };
    console.log(JSON.stringify(report, null, 2));
    return report;
  }
  const alias = env.SSH_BROWSER_TEST_HOST.trim();
  assert.match(alias, ALIAS, 'SSH_BROWSER_TEST_HOST must be a valid SSH config alias');
  assert.equal(process.platform, 'darwin', 'this shared Native Messaging harness targets macOS');
  assert.ok(path.isAbsolute(env.CHROME_TEST_BINARY), 'CHROME_TEST_BINARY must be absolute');
  fs.accessSync(env.CHROME_TEST_BINARY, fs.constants.X_OK);
  const harness = require('./browser-integration.cjs');
  assert.equal(typeof harness.withIsolatedBrowser, 'function', 'shared harness must export withIsolatedBrowser without running its local suite');
  assert.equal(typeof harness.assertState, 'function', 'shared harness must export assertState');
  assert.equal(typeof harness.withTimeout, 'function', 'shared harness must export withTimeout');
  assert.equal(typeof harness.assertResponse, 'function', 'shared harness must export assertResponse');
  let report;
  await harness.withIsolatedBrowser(async session => {
    report = await remoteSession(session, alias, harness);
  });
  console.log(JSON.stringify(report, null, 2));
  return report;
}

function formatError(error, seen = new Set()) {
  if (seen.has(error)) return '[Repeated error]';
  seen.add(error);
  const details = [error?.stack || String(error)];
  if (error?.report) details.push(JSON.stringify(error.report, null, 2));
  if (error instanceof AggregateError) {
    for (const [index, nested] of error.errors.entries()) {
      details.push(`Nested error ${index + 1}:\n${formatError(nested, seen)}`);
    }
  }
  if (error?.cause !== undefined) details.push(`Cause:\n${formatError(error.cause, seen)}`);
  return details.join('\n');
}

module.exports = { remoteGate, main, verifyOpenSSHHome, formatError };
if (require.main === module) {
  main().catch(error => {
    console.error(formatError(error));
    process.exitCode = 1;
  });
}
