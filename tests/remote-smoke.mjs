import test from 'node:test';
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TextDecoder } from 'node:util';

// Opt-in contract (Node 20+, macOS): both SSH_BROWSER_REMOTE_TESTS=1 and a
// nonempty SSH_BROWSER_TEST_HOST are required. HOST must be an existing,
// explicitly approved, trusted SSH config alias, never a new destination.
// ssh -G is read-only itself, but trusted config Match exec can execute commands;
// Match exec, ProxyCommand and ProxyJump must already be reviewed by the caller.
// Neither this runner nor those configured commands may change config, keys or
// known_hosts. Unsafe effective options fail closed; this runner never repairs
// SSH config, installs/signs helpers, or touches browser profiles or proxy state.
// SSH_BROWSER_TEST_URLS optionally adds <=4 URLs in a JSON array (<=8192 bytes,
// <=1024 bytes per URL). The default public destination is always retained.
// Only that exact public URL and HTTP(S) loopback URLs with plain paths are
// accepted. Credentials, query, fragment, percent escapes and redirects are
// forbidden. Paths MUST NOT contain secrets; syntax cannot enforce that promise.
// Loopback is resolved at the SSH server via SOCKS, not at the local Mac.
// No URL, alias, config output, response body, cookies or stderr is ever logged.
// These tests do NOT establish Chrome -> installed helper -> SSH integration.

const alias = process.env.SSH_BROWSER_TEST_HOST ?? '';
const enabled = process.env.SSH_BROWSER_REMOTE_TESTS === '1' && alias.trim() !== '';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAX_FRAME = 256 * 1024;
const REQUEST_MS = 25_000;
const CLEANUP_MS = 6_000;
const PUBLIC_URL = 'https://www.naver.com/';
const children = new Set();
let workSignal;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

class SmokeError extends Error {}
function check(ok, message) {
  if (!ok) throw new SmokeError(message);
}
function sanitized(error) {
  return error instanceof SmokeError ? error : new SmokeError('Remote smoke failed.');
}
function signalGroup(pid, signal) {
  if (!Number.isInteger(pid) || pid <= 1) return;
  try { process.kill(-pid, signal); } catch { /* Already reaped. */ }
}

// Separate process groups, no shell, bounded stdout, and discarded stderr.
// Any spawn/error/timeout path is translated to a fixed, secret-free error.
function run(command, args, { timeout = 5_000, limit = 256 * 1024, env, signal = workSignal } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new SmokeError('Remote smoke interrupted or exceeded its time budget.'));
      return;
    }
    let child;
    try {
      child = spawn(command, args, {
        detached: true, stdio: ['ignore', 'pipe', 'ignore'], env,
      });
    } catch {
      reject(new SmokeError('Subprocess could not start.'));
      return;
    }
    children.add(child);
    let output = Buffer.alloc(0);
    let failure;
    const abort = message => {
      failure ??= new SmokeError(message);
      signalGroup(child.pid, 'SIGKILL');
    };
    const timer = setTimeout(() => abort('Subprocess timed out.'), timeout);
    const interrupted = () => abort('Remote smoke interrupted or exceeded its time budget.');
    signal?.addEventListener('abort', interrupted, { once: true });
    if (signal?.aborted) interrupted();
    child.on('error', () => abort('Subprocess could not start.'));
    child.stdout.on('error', () => abort('Subprocess output failed.'));
    child.stdout.on('data', data => {
      if (failure) return;
      if (output.length + data.length > limit) {
        abort('Subprocess output exceeded its limit.');
        return;
      }
      output = Buffer.concat([output, data]);
    });
    child.on('close', (code, exitSignal) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', interrupted);
      children.delete(child);
      if (failure) reject(failure);
      else if (exitSignal) reject(new SmokeError('Subprocess terminated unexpectedly.'));
      else resolve({ code, output: output.toString('utf8') });
    });
  });
}

function urlsFromEnvironment() {
  const raw = process.env.SSH_BROWSER_TEST_URLS;
  if (raw === undefined) return [PUBLIC_URL];
  check(Buffer.byteLength(raw) <= 8192, 'URL configuration exceeded its limit.');
  let extra;
  try { extra = JSON.parse(raw); } catch { throw new SmokeError('Invalid URL configuration.'); }
  check(Array.isArray(extra) && extra.length <= 4, 'Invalid URL configuration.');
  for (const value of extra) {
    check(typeof value === 'string' && value.length <= 1024, 'Invalid test URL.');
    if (value === PUBLIC_URL) continue;
    // Validate raw text before URL normalization: no alternate IP spellings,
    // backslashes, encoded delimiters, dot traversal or added public targets.
    const match = /^(https?):\/\/(localhost|127\.0\.0\.1|\[::1\])(?::([1-9][0-9]{0,4}))?(\/[A-Za-z0-9._~/-]*)$/.exec(value);
    check(Boolean(match), 'Invalid test URL.');
    check(!match[3] || Number(match[3]) <= 65535, 'Invalid test URL.');
    check(!match[4].split('/').some(part => part === '.' || part === '..'), 'Invalid test URL.');
    const parsed = new URL(value);
    check(!parsed.username && !parsed.password && !parsed.search && !parsed.hash,
      'Invalid test URL.');
  }
  return [...new Set([PUBLIC_URL, ...extra])];
}

// Keep these overrides aligned with helper/host.go; -G does not open a tunnel.
function effectiveArgs(host) {
  return ['-G', '-N', '-T', '-S', 'none', '-D', '127.0.0.1:9',
    '-o', 'ControlMaster=no', '-o', 'ControlPersist=no',
    '-o', 'ForkAfterAuthentication=no', '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=yes', '-o', 'UpdateHostKeys=no',
    '-o', 'CheckHostIP=no', '-o', 'PermitLocalCommand=no',
    '-o', 'AddKeysToAgent=no', '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=2', '--', host];
}

function configPath(value) {
  if (value === 'none') return null;
  const expanded = value.replace(/^~(?=\/)/, os.homedir())
    .replaceAll('%d', os.homedir()).replaceAll('%u', os.userInfo().username);
  check(!expanded.includes('%') && path.isAbsolute(expanded), 'Unsupported SSH file path.');
  return expanded;
}
async function fileStamp(file) {
  try {
    const info = await stat(file, { bigint: true });
    return [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs, info.mode].join(':');
  } catch (error) {
    if (error.code === 'ENOENT') return 'absent';
    throw new SmokeError('SSH file inspection failed.');
  }
}
async function verifyFiles(stamps) {
  for (const [file, stamp] of stamps) {
    check(await fileStamp(file) === stamp, 'SSH file metadata changed.');
  }
}
async function preflight(binary) {
  check(process.platform === 'darwin' && ['arm64', 'x64'].includes(process.arch),
    'Remote smoke requires supported macOS.');
  check(Number(process.versions.node.split('.')[0]) >= 20, 'Remote smoke requires Node 20.');
  check(/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,252}$/.test(alias) && !net.isIP(alias),
    'A trusted existing SSH alias is required.');
  for (const file of [binary, '/usr/bin/ssh', '/usr/bin/curl', '/bin/ps']) {
    try { await access(file, constants.X_OK); }
    catch { throw new SmokeError('Required executable is unavailable.'); }
  }
  const files = new Set([
    path.join(os.homedir(), '.ssh', 'config'), '/etc/ssh/ssh_config',
    path.join(os.homedir(), '.ssh', 'known_hosts'),
    path.join(os.homedir(), '.ssh', 'known_hosts2'),
  ]);
  const stamps = new Map();
  for (const file of files) stamps.set(file, await fileStamp(file));
  const version = await run(binary, ['--version'], { limit: 128 });
  check(version.code === 0 && /^\d+\.\d+\.\d+\s*$/.test(version.output),
    'Helper preflight failed.');
  const evaluated = await run('/usr/bin/ssh', effectiveArgs(alias));
  check(evaluated.code === 0, 'SSH configuration preflight failed.');
  const settings = new Map();
  for (const line of evaluated.output.split('\n')) {
    if (!line) continue;
    const match = /^([A-Za-z][A-Za-z0-9]*)[ \t]+(.*)$/.exec(line);
    check(Boolean(match), 'SSH configuration preflight failed.');
    const field = match[1].toLowerCase();
    const values = settings.get(field) ?? [];
    values.push(match[2]);
    settings.set(field, values);
  }
  const one = key => {
    const values = settings.get(key);
    check(values?.length === 1, 'SSH configuration preflight failed.');
    return values[0];
  };
  // OpenSSH's -G serializer uses no/false and yes/true for different options.
  // Only explicit false values qualify; ask and every unknown value fail closed.
  const disabled = key => ['no', 'false'].includes(one(key));
  const enabledOption = key => ['yes', 'true'].includes(one(key));
  check(disabled('updatehostkeys'), 'Unsafe effective SSH UpdateHostKeys setting.');
  check(disabled('permitlocalcommand'), 'Unsafe effective SSH PermitLocalCommand setting.');
  check(disabled('checkhostip'), 'Unsafe effective SSH CheckHostIP setting.');
  check(disabled('addkeystoagent'), 'Unsafe effective SSH AddKeysToAgent setting.');
  check(['yes', 'true'].includes(one('stricthostkeychecking')) &&
    enabledOption('batchmode') && disabled('controlmaster') &&
    disabled('controlpersist') && disabled('forkafterauthentication'),
  'SSH ownership or authentication preflight failed.');
  check(!settings.has('knownhostscommand') || one('knownhostscommand') === 'none',
    'Unsafe effective SSH KnownHostsCommand setting.');
  check(!settings.has('localforward') && !settings.has('remoteforward'),
    'Inherited SSH forwarding is not allowed.');
  const dynamic = settings.get('dynamicforward');
  check(dynamic?.length === 1 && ['127.0.0.1:9', '[127.0.0.1]:9'].includes(dynamic[0]),
    'Inherited SSH forwarding is not allowed.');

  // Metadata only: never read private key contents. Include absent default files
  // to detect creation; this is a postcondition, not a rollback mechanism.
  // Included config files and side effects of trusted configured commands remain
  // the caller's prerequisite; -G does not enumerate the full Include graph.
  for (const key of ['userknownhostsfile', 'globalknownhostsfile', 'identityfile', 'certificatefile']) {
    for (const value of settings.get(key) ?? []) {
      // Whitespace in effective filenames is unsupported, rather than guessed.
      for (const part of value.split(/\s+/)) {
        const file = configPath(part);
        if (file) files.add(file);
      }
    }
  }
  for (const file of files) {
    if (!stamps.has(file)) stamps.set(file, await fileStamp(file));
  }
  await verifyFiles(stamps);
  return stamps;
}

function encodeFrame(message) {
  const body = Buffer.from(JSON.stringify(message));
  check(body.length > 0 && body.length <= MAX_FRAME, 'Invalid outbound native frame.');
  const header = Buffer.alloc(4);
  if (os.endianness() === 'LE') header.writeUInt32LE(body.length);
  else header.writeUInt32BE(body.length);
  return Buffer.concat([header, body]);
}

class NativeSession {
  constructor(binary) {
    this.pending = new Map();
    this.buffer = Buffer.alloc(0);
    this.sequence = 0;
    this.ending = false;
    this.failure = null;
    this.child = spawn(binary, [], { detached: true, stdio: ['pipe', 'pipe', 'ignore'] });
    children.add(this.child);
    this.closed = new Promise(resolve => {
      this.child.on('close', (code, signal) => {
        children.delete(this.child);
        if (this.buffer.length) this.fail('Truncated native frame.');
        if (!this.ending) this.fail('Native helper exited unexpectedly.');
        this.rejectPending('Native helper closed.');
        this.exit = { code, signal };
        resolve(this.exit);
      });
    });
    this.child.on('error', () => this.fail('Native helper could not start.'));
    this.child.stdin.on('error', () => this.fail('Native input failed.'));
    this.child.stdout.on('error', () => this.fail('Native output failed.'));
    this.child.stdout.on('end', () => {
      if (this.buffer.length) this.fail('Truncated native frame.');
      if (!this.ending) this.fail('Native output ended unexpectedly.');
    });
    this.child.stdout.on('data', data => this.consume(data));
  }
  rejectPending(message) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new SmokeError(message));
    }
    this.pending.clear();
  }
  fail(message) {
    this.failure ??= new SmokeError(message);
    this.rejectPending(message);
    // EOF lets the helper reap its independently owned SSH process groups.
    this.end();
  }
  consume(data) {
    if (this.failure) return;
    // Consume large chunks incrementally; retain at most one bounded frame.
    let offset = 0;
    try {
      while (offset < data.length) {
        const length = this.buffer.length < 4 ? 4 : 4 +
          (os.endianness() === 'LE' ? this.buffer.readUInt32LE(0) : this.buffer.readUInt32BE(0));
        const amount = Math.min(length - this.buffer.length, data.length - offset);
        this.buffer = Buffer.concat([this.buffer, data.subarray(offset, offset + amount)]);
        offset += amount;
        if (this.buffer.length < 4) continue;
        const size = os.endianness() === 'LE' ? this.buffer.readUInt32LE(0) : this.buffer.readUInt32BE(0);
        check(size > 0 && size <= MAX_FRAME, 'Invalid native frame size.');
        if (this.buffer.length !== size + 4) continue;
        const json = new TextDecoder('utf-8', { fatal: true }).decode(this.buffer.subarray(4));
        const reply = JSON.parse(json);
        this.buffer = Buffer.alloc(0);
        check(reply && typeof reply === 'object' && !Array.isArray(reply), 'Invalid native reply.');
        if (reply.event !== undefined) {
          check(reply.event === 'tunnel-exit', 'Invalid native event.');
          throw new SmokeError('Owned SSH tunnel exited unexpectedly.');
        }
        const pending = this.pending.get(reply.requestId);
        check(Boolean(pending) && typeof reply.ok === 'boolean', 'Uncorrelated native reply.');
        this.pending.delete(reply.requestId);
        clearTimeout(pending.timer);
        if (reply.ok) pending.resolve(reply.result);
        else pending.reject(new SmokeError('Native request failed.'));
      }
    } catch (error) { this.fail(sanitized(error).message); }
  }
  request(type, fields = {}) {
    if (this.failure) return Promise.reject(this.failure);
    if (this.ending) return Promise.reject(new SmokeError('Native session is closed.'));
    const requestId = `remote-${++this.sequence}`;
    let bytes;
    try { bytes = encodeFrame({ type, requestId, ...fields }); }
    catch { return Promise.reject(new SmokeError('Native request encoding failed.')); }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail('Native request timed out.'), REQUEST_MS);
      this.pending.set(requestId, { resolve, reject, timer });
      try {
        this.child.stdin.write(bytes, error => {
          if (error) this.fail('Native input failed.');
        });
      } catch { this.fail('Native input failed.'); }
    });
  }
  end() {
    if (this.ending) return;
    this.ending = true;
    this.rejectPending('Native session ended.');
    try { this.child.stdin.end(); } catch { /* Cleanup continues below. */ }
  }
  async waitForClose(timeout = CLEANUP_MS) {
    let timer;
    try {
      return await Promise.race([this.closed, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new SmokeError('Native helper cleanup timed out.')), timeout);
      })]);
    } finally { clearTimeout(timer); }
  }
}

async function processTable() {
  // comm deliberately excludes command arguments, aliases, keys and URLs.
  const result = await run('/bin/ps', ['-ax', '-o', 'pid=', '-o', 'ppid=', '-o', 'pgid=', '-o', 'comm='],
    { timeout: 2_000, limit: 1024 * 1024 });
  check(result.code === 0, 'Process ownership inspection failed.');
  return result.output.trim().split('\n').map(line => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    check(Boolean(match), 'Process ownership inspection failed.');
    return { pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), comm: match[4] };
  });
}
class OwnedGroups {
  constructor(session) {
    this.session = session;
    this.groups = new Set();
    this.stopped = false;
    this.failure = null;
    this.loop = this.monitor();
  }
  async capture() {
    const rows = await processTable();
    for (const row of rows) {
      if (row.ppid !== this.session.child.pid) continue;
      // A forked child can still show the helper name before exec. Track only
      // positively observed SSH groups; macOS uses "(ssh)" before reaping.
      const command = path.basename(row.comm);
      if (row.pgid === row.pid && ['ssh', '(ssh)'].includes(command)) {
        this.groups.add(row.pgid);
      }
    }
    return rows;
  }
  async monitor() {
    while (!this.stopped) {
      try { await this.capture(); }
      catch { this.failure = new SmokeError('Process ownership inspection failed.');
        this.session.fail(this.failure.message); break; }
      if (!this.stopped) await delay(100);
    }
  }
  async assertGone() {
    const deadline = Date.now() + CLEANUP_MS;
    do {
      const rows = await this.capture();
      if (!rows.some(row => this.groups.has(row.pgid))) return;
      await delay(100);
    } while (Date.now() < deadline);
    throw new SmokeError('Owned SSH process group was not cleaned up.');
  }
  async stop() { this.stopped = true; await this.loop; }
  kill(signal) { for (const group of this.groups) signalGroup(group, signal); }
}

async function portIsClosed(port) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    const finish = (closed, error) => {
      socket.destroy();
      if (error) reject(new SmokeError('Tunnel port inspection failed.'));
      else resolve(closed);
    };
    socket.setTimeout(500, () => finish(false, true));
    socket.once('connect', () => finish(false));
    socket.once('error', error => finish(error.code === 'ECONNREFUSED', error.code !== 'ECONNREFUSED'));
  });
}
async function expectPortClosed(port) {
  const deadline = Date.now() + CLEANUP_MS;
  do {
    if (await portIsClosed(port)) return;
    await delay(100);
  } while (Date.now() < deadline);
  throw new SmokeError('Owned tunnel port remained open.');
}
async function expectStatus(session, tunnel) {
  const result = await session.request('status');
  check(Array.isArray(result?.tunnels), 'Invalid native status.');
  if (!tunnel) {
    check(result.tunnels.length === 0, 'Native status was not empty.');
    return;
  }
  const active = result.tunnels[0];
  check(result.tunnels.length === 1 && active?.tunnelId === tunnel.tunnelId &&
    active.hostId === 'remote-smoke-host' && active.port === tunnel.port && active.status === 'ready',
  'Native status did not match the owned tunnel.');
}
async function connect(session, groups, ports) {
  const result = await session.request('connect', {
    host: { id: 'remote-smoke-host', name: 'Remote smoke', mode: 'alias', alias },
  });
  check(result && Number.isInteger(result.port) && result.port > 0 && result.port <= 65535 &&
    typeof result.tunnelId === 'string' && /^[a-f0-9]{32}$/.test(result.tunnelId) &&
    result.hostId === 'remote-smoke-host' && result.status === 'ready', 'Invalid native tunnel.');
  ports.add(result.port);
  const rows = await groups.capture();
  check(rows.some(row => row.ppid === session.child.pid && row.pgid === row.pid &&
    path.basename(row.comm) === 'ssh' && groups.groups.has(row.pgid)),
    'Owned SSH process group was not found.');
  if (groups.failure) throw groups.failure;
  await expectStatus(session, result);
  return result;
}

async function curlThroughTunnel(t, port, url) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(all|http|https|no)_proxy$/i.test(key)) delete env[key];
  }
  // -q MUST be first: ignore .curlrc (cookies, headers, redirects, verbosity).
  // No --location: even an allowed URL cannot redirect to another destination.
  const result = await run('/usr/bin/curl', ['-q', '--silent', '--globoff',
    '--socks5-hostname', `127.0.0.1:${port}`, '--noproxy', '',
    '--proto', '=http,https', '--connect-timeout', '10', '--max-time', '20',
    '--output', '/dev/null', '--write-out', '%{http_code} %{time_connect} %{time_starttransfer} %{time_total}',
    '--url', url], { timeout: 23_000, limit: 256, env });
  const metrics = /^(\d{3}) (\d+(?:\.\d+)?) (\d+(?:\.\d+)?) (\d+(?:\.\d+)?)$/.exec(result.output);
  check(Boolean(metrics), 'Invalid curl metrics.');
  const times = metrics.slice(2).map(Number);
  check(times.every(value => Number.isFinite(value) && value >= 0 && value <= 23), 'Invalid curl metrics.');
  // Only exit code, HTTP status and timing; never print captured output directly.
  t.diagnostic(JSON.stringify({ exitCode: result.code, httpStatus: Number(metrics[1]),
    connectSeconds: times[0], firstByteSeconds: times[1], totalSeconds: times[2] }));
  check(result.code === 0 && Number(metrics[1]) >= 200 && Number(metrics[1]) < 400,
    'Curl through the owned tunnel failed.');
}

async function cleanup(session, groups, ports) {
  let failure;
  if (session) {
    // Capture ownership before requesting EOF, including failed/pending connect.
    try { await groups.capture(); } catch { failure = new SmokeError('Process cleanup inspection failed.'); }
    session.end();
    try { await session.waitForClose(); }
    catch {
      failure ??= new SmokeError('Native helper cleanup timed out.');
      signalGroup(session.child.pid, 'SIGTERM');
      groups.kill('SIGTERM');
      await delay(200);
      signalGroup(session.child.pid, 'SIGKILL');
      groups.kill('SIGKILL');
      try { await session.waitForClose(2_000); }
      catch { failure = new SmokeError('Native helper could not be reaped.'); }
    }
    await groups.stop();
    try { await groups.assertGone(); }
    catch {
      failure ??= new SmokeError('Owned SSH cleanup failed.');
      groups.kill('SIGTERM');
      await delay(200);
      groups.kill('SIGKILL');
      try { await groups.assertGone(); }
      catch { failure = new SmokeError('Owned SSH process group remained alive.'); }
    }
    const portChecks = await Promise.allSettled([...ports].map(expectPortClosed));
    if (portChecks.some(result => result.status === 'rejected')) {
      failure ??= new SmokeError('Owned tunnel port remained open.');
    }
  }
  // Normally empty: defensive cleanup also handles early preflight failure.
  const remaining = [...children];
  for (const child of remaining) signalGroup(child.pid, 'SIGKILL');
  if (remaining.length) {
    await delay(200);
    check(children.size === 0, 'Subprocess cleanup failed.');
    failure ??= new SmokeError('Unexpected subprocess remained after cleanup.');
  }
  if (failure) throw failure;
}

test('opt-in remote Native Messaging SOCKS smoke and owned process cleanup', {
  skip: enabled ? false : 'Requires SSH_BROWSER_REMOTE_TESTS=1 and SSH_BROWSER_TEST_HOST.',
  timeout: 120_000,
}, async t => {
  let session;
  let groups;
  let stamps;
  let failure;
  let interruptionExitCode;
  const ports = new Set();
  const abort = new AbortController();
  workSignal = abort.signal;
  const interrupt = () => {
    failure ??= new SmokeError('Remote smoke interrupted or exceeded its time budget.');
    // EOF first; never force-kill the helper while it can still reap SSH groups.
    session?.fail('Remote smoke interrupted or exceeded its time budget.');
    abort.abort();
  };
  const onSigint = () => { interruptionExitCode ??= 130; interrupt(); };
  const onSigterm = () => { interruptionExitCode ??= 143; interrupt(); };
  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigterm);
  t.signal.addEventListener('abort', interrupt, { once: true });
  // Cooperative deadline leaves 40s for bounded graceful/fallback cleanup before
  // node:test's hard 120s deadline. Long optional URL lists can hit this budget.
  const deadline = setTimeout(interrupt, 80_000);
  try {
    const urls = urlsFromEnvironment();
    const arch = process.arch === 'arm64' ? 'arm64' : 'amd64';
    const binary = path.join(root, 'bin', `ssh-browser-helper-darwin-${arch}`);
    stamps = await preflight(binary);
    await processTable();
    session = new NativeSession(binary);
    groups = new OwnedGroups(session);
    const hello = await session.request('hello', { protocol: 1, profileId: 'remote-smoke-profile' });
    check(hello?.protocol === 1 && typeof hello.version === 'string', 'Invalid native hello.');
    await expectStatus(session);

    const first = await connect(session, groups, ports);
    for (const url of urls) await curlThroughTunnel(t, first.port, url);
    const released = await session.request('release', { tunnelId: first.tunnelId });
    check(released?.released === true, 'Native release failed.');
    await expectStatus(session);
    await expectPortClosed(first.port);
    await groups.assertGone();

    const second = await connect(session, groups, ports);
    const disconnected = await session.request('disconnect');
    check(disconnected?.disconnected === true, 'Native disconnect failed.');
    await expectStatus(session);
    await expectPortClosed(second.port);
    await groups.assertGone();

    // Reconnect before EOF: checking EOF on an empty session proves no cleanup.
    const third = await connect(session, groups, ports);
    session.end();
    const exit = await session.waitForClose();
    check(exit.code === 0 && !exit.signal, 'Native EOF exit failed.');
    await expectPortClosed(third.port);
    await groups.assertGone();
    if (session.failure) throw session.failure;
    if (groups.failure) throw groups.failure;
  } catch (error) { failure = sanitized(error); }
  finally {
    clearTimeout(deadline);
    // Cleanup inspections must still run after an interrupt aborted normal work.
    workSignal = undefined;
    try { await cleanup(session, groups, ports); }
    catch (error) { failure = sanitized(error); }
    if (stamps) {
      try { await verifyFiles(stamps); }
      catch (error) { failure = sanitized(error); }
    }
    process.removeListener('SIGINT', onSigint);
    process.removeListener('SIGTERM', onSigterm);
    t.signal.removeEventListener('abort', interrupt);
    // Let node:test finalize and let Node reap/close handles; never process.exit.
    if (interruptionExitCode) process.exitCode = interruptionExitCode;
  }
  // Do not attach cause, subprocess output, assertion actual/expected or inputs.
  if (failure) throw new Error(failure.message);
});
