import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { retryLabel, validateHost } from '../extension/core.js';

// Run the complete UI, replacing only browser APIs. No extension profile,
// proxy, helper, real timers, or persistent storage is touched by these tests.
const source = await readFile(new URL('../extension/ui.js', import.meta.url), 'utf8');
const html = await readFile(new URL('../extension/options.html', import.meta.url), 'utf8');
const host = (id, extra = {}) => ({ id, name: id, group: '', favorite: false,
  mode: 'manual', alias: '', address: 'example.org', port: 22, user: 'dev', keyPath: '', ...extra });
const initial = (extra = {}) => ({ hosts: [], status: 'disabled', desiredMode: 'disabled',
  activeHostId: null, selectedHostId: null, error: null, helperAvailable: null,
  setupErrorCode: null, retryAttempt: 0, retryLimit: 0, ...extra });
const settle = async () => { await new Promise(resolve => setImmediate(resolve)); };
const deferred = () => { let resolve, reject; const promise = new Promise((r, j) => { resolve = r; reject = j; }); return { promise, resolve, reject }; };

class NodeStub {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase(); this.children = []; this.dataset = {};
    this.attributes = {}; this.listeners = new Map(); this.value = ''; this.hidden = false;
    this.disabled = false; this.open = false; this.className = ''; this._text = '';
    this.classList = { toggle: (name, on) => {
      const names = new Set(this.className.split(/\s+/).filter(Boolean));
      if (on) names.add(name); else names.delete(name); this.className = [...names].join(' ');
    } };
  }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map(node => node.textContent).join(''); }
  set innerHTML(_value) { throw new Error('UI must render untrusted values through textContent'); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  append(...nodes) {
    for (let node of nodes) {
      if (typeof node === 'string') { const text = new NodeStub('#text'); text.textContent = node; node = text; }
      if (node.tagName === '#FRAGMENT') this.append(...node.children);
      else { node.parent = this; this.children.push(node); }
    }
  }
  replaceChildren(...nodes) { this._text = ''; this.children = []; this.append(...nodes); }
  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || new Set(); listeners.add(listener); this.listeners.set(type, listeners);
  }
  removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener); }
  async dispatch(type, extra = {}) {
    const event = { target: this, preventDefault() {}, stopPropagation() {}, ...extra };
    for (const listener of [...(this.listeners.get(type) || [])]) await listener(event);
  }
  async click() { if (!this.disabled) await this.dispatch('click'); }
  showModal() { this.open = true; }
  close() { this.open = false; void this.dispatch('close'); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(node => node !== this); }
  focus() { if (this.document) this.document.activeElement = this; }
}

function fixture({ preview = false, popup = false, incognito = false, state = initial(), reply } = {}) {
  const nodes = new Map();
  // IDs also declared explicitly so behavior tests can run while the separate
  // HTML worker is still editing. HTML integration is reviewed independently.
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
  ids.push('setup-panel', 'setup-status', 'setup-error', 'setup-instructions', 'check-helper',
    'connection-lock-note', 'popup-host-list', 'open-settings', 'popup-brand');
  for (const id of ids) { const node = new NodeStub(); node.id = id; nodes.set(id, node); }
  const get = id => { assert.ok(nodes.has(id), `Missing DOM stub: ${id}`); return nodes.get(id); };
  const modes = ['alias', 'manual'].map(value => {
    const node = new NodeStub('input'); node.value = value;
    Object.defineProperty(node, 'checked', { get: () => node._checked || false,
      set: value => { node._checked = Boolean(value); if (value) for (const sibling of modes) if (sibling !== node) sibling._checked = false; } });
    return node;
  });
  modes[0].checked = true;
  const filters = ['all', 'favorites'].map(filter => { const node = new NodeStub('button'); node.dataset.filter = filter; return node; });
  const document = new NodeStub(); document.body = new NodeStub('body'); document.body.dataset.view = popup ? 'popup' : 'options';
  document.getElementById = id => nodes.get(id) || null;
  document.createElement = tag => { const node = new NodeStub(tag); node.document = document; return node; };
  document.createDocumentFragment = () => new NodeStub('#fragment');
  document.createTextNode = text => { const node = new NodeStub('#text'); node.textContent = text; return node; };
  document.querySelectorAll = selector => selector === 'input[name=mode]' ? modes : selector === '[data-filter]' ? filters : [];
  document.querySelector = selector => selector.includes(':checked') ? modes.find(node => node.checked) : modes.find(node => selector.includes(`value=${node.value}`));
  for (const node of nodes.values()) node.document = document;
  get('host-form').reset = () => {
    for (const [id, node] of nodes) if (id.startsWith('host-')) { node.value = ''; node.checked = false; }
    modes[0].checked = true;
  };
  const calls = [], listeners = new Set(), storage = new Map(), timers = new Map(); let timerId = 0;
  const runtime = { ...(preview ? {} : { id: 'test-extension' }),
    sendMessage(message) { calls.push(structuredClone(message)); return reply ? reply(message) : Promise.resolve({ ok: true, state }); },
    onMessage: { addListener: listener => listeners.add(listener), removeListener: listener => listeners.delete(listener) },
    openOptionsPage: async () => {} };
  const window = new NodeStub();
  const context = vm.createContext({ document, window, chrome: { runtime, extension: { inIncognitoContext: incognito } },
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    crypto: { randomUUID: () => 'new-host' }, location: { href: '' }, validateHost, retryLabel,
    setTimeout: callback => { timers.set(++timerId, callback); return timerId; }, clearTimeout: id => timers.delete(id),
    setInterval: callback => { timers.set(++timerId, callback); return timerId; }, clearInterval: id => timers.delete(id) });
  vm.runInContext(source.replace(/^import\s+\{[^}]*\}\s+from\s+['"]\.\/core\.js['"];?\s*/u, '') + `
    globalThis.ui = { openDialog, saveHost, deleteHost, setFilter,
      get state() { return state; }, get busy() { return busy; } };
  `, context, { filename: 'extension/ui.js' });
  return { get, ui: context.ui, document, window, calls, filters, modes, storage, listeners,
    broadcast(next, sender = 'test-extension') { for (const listener of listeners) listener({ type: 'STATE_CHANGED', state: next }, { id: sender }); },
    dispose() { void window.dispatch('pagehide'); } };
}
const descendants = node => [node, ...node.children.flatMap(descendants)];
const findButton = (node, text) => descendants(node).find(child => child.tagName === 'BUTTON' && child.textContent === text);
async function submit(f, values) {
  for (const [key, value] of Object.entries(values)) f.get(`host-${key}`).value = value;
  await f.get('host-form').dispatch('submit'); await settle();
}

test('STATE_CHANGED renders immediately while CONNECT is busy; stale mutation reply cannot regress it', async t => {
  const waiting = deferred(), a = host('a');
  const f = fixture({ reply: message => message.type === 'GET_STATE' ? Promise.resolve({ ok: true, state: initial({ hosts: [a] }) }) : waiting.promise });
  t.after(() => f.dispose()); await settle();
  await findButton(f.get('host-grid'), '연결').click();
  assert.equal(f.ui.busy, true);
  f.broadcast(initial({ hosts: [a], status: 'reconnecting', desiredMode: 'remote', selectedHostId: 'a', retryAttempt: 2, retryLimit: 3 }));
  assert.equal(f.get('status-title').textContent, 'SSH 재연결 중');
  assert.match(f.get('status-description').textContent, /2\s*\/\s*3/);
  assert.match(f.get('status-description').textContent, /직접 연결로 자동 전환하지/);
  assert.equal(f.get('stop-button').disabled, true);
  waiting.resolve({ ok: true, state: initial({ hosts: [a], status: 'connecting' }) }); await settle();
  assert.equal(f.ui.state.status, 'reconnecting'); assert.equal(f.ui.busy, false);
  assert.equal(f.get('stop-button').disabled, false);
});

test('late initial GET_STATE cannot overwrite a newer broadcast; foreign broadcasts are ignored', async t => {
  const waiting = deferred(); const f = fixture({ reply: () => waiting.promise }); t.after(() => f.dispose());
  f.broadcast(initial({ status: 'local', desiredMode: 'local' }));
  waiting.resolve({ ok: true, state: initial() }); await settle();
  assert.equal(f.ui.state.status, 'local'); assert.equal(f.get('status-title').textContent, '로컬 직접 연결');
  f.broadcast(initial({ status: 'connected' }), 'unrelated-extension');
  assert.equal(f.ui.state.status, 'local');
});

test('late GET_STATE error cannot reintroduce an error after a healthy broadcast', async t => {
  for (const rejected of [false, true]) {
    const waiting = deferred(); const f = fixture({ reply: () => waiting.promise }); t.after(() => f.dispose());
    f.broadcast(initial({ status: 'local', desiredMode: 'local' }));
    if (rejected) waiting.reject(new Error('stale GET_STATE failure'));
    else waiting.resolve({ ok: false, error: 'stale GET_STATE failure', state: initial({ status: 'error' }) });
    await settle(); assert.equal(f.ui.state.status, 'local'); assert.equal(f.get('error-panel').hidden, true);
  }
});

test('error descriptions distinguish remote, local and released proxy intentions', async t => {
  const f = fixture(); t.after(() => f.dispose()); await settle();
  for (const [desiredMode, title, description] of [
    ['remote', 'SSH 연결 확인 필요', /직접 연결로 자동 전환하지/],
    ['local', '직접 연결 확인 필요', /로컬 직접 연결 설정/],
    ['disabled', '프록시 설정 확인 필요', /프록시 제어 해제/],
  ]) {
    f.broadcast(initial({ status: 'error', desiredMode }));
    assert.equal(f.get('status-title').textContent, title);
    assert.match(f.get('status-description').textContent, description);
  }
});

test('CHECK_HELPER sends only a health request and unknown setup error codes remain visible text', async t => {
  const f = fixture({ reply: async message => ({ ok: true, state: initial(message.type === 'CHECK_HELPER'
    ? { helperAvailable: true, helperVersion: 'test' } : {}) }) }); t.after(() => f.dispose()); await settle(); f.calls.length = 0;
  await f.get('check-helper').click(); await settle();
  assert.deepEqual(f.calls, [{ type: 'CHECK_HELPER' }]);
  assert.equal(f.ui.state.status, 'disabled'); assert.match(f.get('setup-status').textContent, /사용 가능.*test/);
  const code = '<img src=x onerror=alert(1)>';
  f.broadcast(initial({ helperAvailable: false, setupErrorCode: code }));
  assert.equal(f.get('setup-error').hidden, false); assert.ok(f.get('setup-error').textContent.includes(code));
  assert.equal(f.get('setup-error').children.length, 0);
});

test('setup error mappings accept open strings without inherited object properties', async t => {
  const f = fixture(); t.after(() => f.dispose()); await settle();
  for (const [code, explanation] of [
    ['PROTOCOL', /버전이 맞지/], ['NATIVE_UNAVAILABLE', /접근하지 못/], ['NATIVE_TIMEOUT', /제한 시간/],
    ['FUTURE_HELPER_CODE', /설치 확인에 실패/], ['__proto__', /설치 확인에 실패/], ['constructor', /설치 확인에 실패/],
  ]) {
    f.broadcast(initial({ helperAvailable: false, setupErrorCode: code }));
    assert.match(f.get('setup-error').textContent, explanation, code);
    assert.ok(f.get('setup-error').textContent.includes(`(${code})`));
  }
});

test('active connection fields stay locked and saving metadata preserves actual connection fields', async t => {
  for (const mode of ['manual', 'alias']) {
    const a = host('a', { mode, alias: 'oracle', port: 2200, keyPath: '/tmp/test-key' });
    const current = initial({ hosts: [a], status: 'connected', desiredMode: 'remote', activeHostId: 'a', selectedHostId: 'a' });
    const f = fixture({ state: current }); t.after(() => f.dispose()); await settle(); f.ui.openDialog(a);
    for (const field of ['alias', 'address', 'port', 'user', 'keyPath']) assert.equal(f.get(`host-${field}`).disabled, true, field);
    for (const node of f.modes) assert.equal(node.disabled, true);
    for (const field of ['name', 'group', 'favorite']) assert.equal(f.get(`host-${field}`).disabled, false, field);
    f.get('host-favorite').checked = true;
    await submit(f, { name: 'Renamed', group: 'Production', address: 'tampered.invalid', alias: 'tampered', port: '1' });
    const saved = f.calls.find(message => message.type === 'SAVE_HOST').host;
    assert.deepEqual(saved, { ...a, name: 'Renamed', group: 'Production', favorite: true });
    assert.equal(f.get('host-dialog').open, false);
    await f.ui.deleteHost(a); assert.equal(f.calls.some(message => message.type === 'DELETE_HOST'), false);
  }
});

test('broadcast locks an already open editor when its host becomes pending', async t => {
  const a = host('a'); const f = fixture({ state: initial({ hosts: [a] }) }); t.after(() => f.dispose()); await settle(); f.ui.openDialog(a);
  assert.equal(f.get('host-address').disabled, false);
  f.broadcast(initial({ hosts: [a], desiredMode: 'remote', status: 'reconnecting', selectedHostId: 'a', pendingRemote: { hostId: 'a' } }));
  assert.equal(f.get('host-address').disabled, true); assert.equal(f.get('connection-lock-note').hidden, false);
  f.ui.openDialog(); assert.equal(f.get('host-alias').disabled, false); assert.equal(f.modes[0].disabled, false);
});

test('pendingRemote host is locked even when a different host is selected', async t => {
  const a = host('a'), b = host('b');
  const f = fixture({ state: initial({ hosts: [a, b], status: 'connecting', desiredMode: 'remote', selectedHostId: 'b', pendingRemote: { hostId: 'a' } }) });
  t.after(() => f.dispose()); await settle(); f.ui.openDialog(a);
  assert.equal(f.get('host-address').disabled, true);
  await f.ui.deleteHost(a); assert.equal(f.calls.some(message => message.type === 'DELETE_HOST'), false);
});

test('invalid alias stays in the editor without SAVE_HOST or CONNECT requests', async t => {
  const f = fixture(); t.after(() => f.dispose()); await settle(); f.calls.length = 0;
  f.ui.openDialog(); await submit(f, { name: 'Invalid', alias: '-bad alias' });
  assert.equal(f.get('host-dialog').open, true); assert.equal(f.get('form-error').hidden, false);
  assert.deepEqual(f.calls, []);
});

test('preview CRUD, search, groups, favorites and modal deletion stay entirely local', async t => {
  const f = fixture({ preview: true }); t.after(() => f.dispose()); await settle();
  await f.get('add-host').click(); assert.equal(f.get('host-dialog').open, true);
  await submit(f, { name: 'Oracle', group: 'Research', alias: 'oracle' });
  assert.equal(f.ui.state.hosts.length, 1); assert.equal(f.get('group-count').textContent, '1');
  await f.get('search').dispatch('input', { target: { value: 'missing' } }); assert.equal(f.get('host-grid').children.length, 0);
  await f.get('search').dispatch('input', { target: { value: 'ORACLE' } }); assert.equal(f.get('host-grid').children.length, 1);
  await f.get('group-list').children[0].click(); assert.equal(f.get('page-title').textContent, 'Research');
  const favorite = descendants(f.get('host-grid')).find(node => node.attributes['aria-label'] === 'Oracle 즐겨찾기 추가');
  await favorite.click(); await settle(); assert.equal(f.ui.state.hosts[0].favorite, true);
  await f.filters[1].click(); assert.equal(f.get('host-grid').children.length, 1);
  f.ui.openDialog(f.ui.state.hosts[0]); await submit(f, { name: 'Oracle edited' });
  assert.equal(f.ui.state.hosts[0].name, 'Oracle edited');
  let deleting = f.ui.deleteHost(f.ui.state.hosts[0]);
  let dialog = f.document.body.children.find(node => node.tagName === 'DIALOG');
  assert.equal(dialog.open, true); await dialog.dispatch('cancel'); await deleting;
  assert.equal(f.ui.state.hosts.length, 1); assert.equal(f.document.body.children.length, 0);
  deleting = f.ui.deleteHost(f.ui.state.hosts[0]); dialog = f.document.body.children.find(node => node.tagName === 'DIALOG');
  await findButton(dialog, '삭제 확인').click(); await deleting;
  assert.equal(f.ui.state.hosts.length, 0); assert.deepEqual(f.calls, []); assert.equal(f.listeners.size, 0);
});

test('preview connect, LOCAL and STOP do not send runtime messages or report a real route', async t => {
  const f = fixture({ preview: true }); t.after(() => f.dispose()); await settle();
  f.ui.openDialog(); await submit(f, { name: 'Preview', alias: 'oracle' });
  for (const node of [findButton(f.get('host-grid'), '연결'), f.get('local-button'), f.get('stop-button')]) {
    await node.click(); await settle(); assert.deepEqual(f.calls, []);
    assert.equal(f.ui.state.status, 'disabled'); assert.equal(f.ui.state.activeHostId, null);
    assert.equal(f.get('status-title').textContent, 'UI 미리보기');
    assert.match(f.get('error-text').textContent, /미리보기에서는 실제 SSH 연결이나 프록시 변경/);
  }
  assert.equal(f.get('check-helper').disabled, true);
});

test('LOCAL and STOP remain distinct actions; popup receives live broadcasts', async t => {
  const a = host('a'); const current = initial({ hosts: [a] });
  const f = fixture({ popup: true, reply: async message => ({ ok: true, state: message.type === 'LOCAL'
    ? { ...current, status: 'local', desiredMode: 'local' } : current }) }); t.after(() => f.dispose()); await settle(); f.calls.length = 0;
  await f.get('local-button').click(); await settle(); assert.equal(f.ui.state.status, 'local');
  await f.get('stop-button').click(); await settle(); assert.equal(f.ui.state.status, 'disabled');
  assert.deepEqual(f.calls.map(message => message.type), ['LOCAL', 'STOP']);
  f.broadcast({ ...current, status: 'connected', desiredMode: 'remote', activeHostId: 'a' });
  assert.equal(f.get('status-pill').textContent, 'SSH 연결됨');
  assert.equal(f.get('popup-host-list').children[0].disabled, true);
});

test('host names, groups, details and delete confirmation render hostile strings as text', async t => {
  const payload = '<img src=x onerror=alert(1)>'; const a = host('a', { name: payload, group: payload, keyPath: `/tmp/${payload}` });
  const f = fixture({ state: initial({ hosts: [a] }) }); t.after(() => f.dispose()); await settle();
  assert.ok(f.get('host-grid').textContent.includes(payload)); assert.ok(f.get('group-list').textContent.includes(payload));
  await f.get('host-grid').children[0].click(); assert.ok(f.get('host-details').textContent.includes(`/tmp/${payload}`));
  const deleting = f.ui.deleteHost(a); const dialog = f.document.body.children[0];
  assert.ok(dialog.textContent.includes(payload)); await dialog.dispatch('cancel'); await deleting;
  assert.equal(descendants(f.get('host-grid')).some(node => node.tagName === 'IMG'), false);
});

test('incognito starts no requests or listeners, and pagehide removes the normal listener', async () => {
  const privateUI = fixture({ incognito: true }); await settle();
  assert.deepEqual(privateUI.calls, []); assert.equal(privateUI.listeners.size, 0); assert.equal(privateUI.get('app').hidden, true);
  const normal = fixture(); await settle(); assert.equal(normal.listeners.size, 1);
  normal.dispose(); assert.equal(normal.listeners.size, 0);
});

test('both HTML views load actual Primer before app CSS, and status classes exist in the vendored release', async t => {
  const primer = await readFile(new URL('../extension/vendor/primer/primer.css', import.meta.url), 'utf8');
  for (const file of ['options.html', 'popup.html']) {
    const page = await readFile(new URL(`../extension/${file}`, import.meta.url), 'utf8');
    assert.ok(page.indexOf('href="vendor/primer/primer.css"') >= 0, file);
    assert.ok(page.indexOf('href="vendor/primer/primer.css"') < page.indexOf('href="ui.css"'), file);
    assert.match(page, /<html\b[^>]*data-color-mode="auto"[^>]*data-light-theme="light"[^>]*data-dark-theme="dark"/);
    for (const id of ['setup-panel', 'check-helper', 'setup-status', 'setup-error', 'setup-instructions', 'status-pill', 'local-button', 'stop-button']) {
      assert.ok(page.includes(`id="${id}"`), `${file}: ${id}`);
    }
    assert.doesNotMatch(page, /class="[^"]*\b(?:State|flash|Label)\b/);
  }
  const f = fixture(); t.after(() => f.dispose()); await settle();
  for (const status of ['disabled', 'connecting', 'reconnecting', 'connected', 'local', 'error']) {
    f.broadcast(initial({ status }));
    const classes = f.get('status-pill').className.split(/\s+/);
    assert.ok(classes.includes('status-pill')); assert.ok(classes.includes('IssueLabel'));
    for (const name of classes.filter(name => name !== 'status-pill')) {
      assert.match(primer, new RegExp(`\\.${name}(?=[\\s.{:#,>\\[])`), `${status}: ${name}`);
    }
  }
});

test('a failed action stays visible after an unrelated STATE_CHANGED broadcast', async t => {
  const a = host('a'); const current = initial({ hosts: [a] });
  const f = fixture({ popup: true, reply: async message => message.type === 'LOCAL'
    ? { ok: false, error: 'policy blocks DIRECT', state: current } : { ok: true, state: current } });
  t.after(() => f.dispose()); await settle();
  await f.get('local-button').click(); await settle();
  assert.equal(f.get('error-panel').hidden, false);
  f.broadcast(current);
  assert.equal(f.get('error-panel').hidden, false); assert.match(f.get('error-text').textContent, /policy blocks DIRECT/);
});

test('reconnect copy names the next attempt while waiting for backoff', async t => {
  const f = fixture({ popup: true }); t.after(() => f.dispose()); await settle();
  f.broadcast(initial({ status: 'reconnecting', desiredMode: 'remote', retryAttempt: 0, retryLimit: 3, reconnect: { nextRetryAt: 1 } }));
  assert.match(f.get('status-description').textContent, /1\/3회째 대기/);
  f.broadcast(initial({ status: 'reconnecting', desiredMode: 'remote', retryAttempt: 1, retryLimit: 3, reconnect: { nextRetryAt: null } }));
  assert.match(f.get('status-description').textContent, /1\/3회째 시도/);
});

test('reconnect copy says when it is waiting for the network; connected copy shows setup time', async t => {
  const a = host('a'); const f = fixture({ popup: true }); t.after(() => f.dispose()); await settle();
  f.broadcast(initial({ hosts: [a], status: 'reconnecting', desiredMode: 'remote', retryAttempt: 0, retryLimit: 3, networkOnline: false, reconnect: { nextRetryAt: 1 } }));
  assert.match(f.get('status-description').textContent, /네트워크 연결 대기 중/);
  f.broadcast(initial({ hosts: [a], status: 'connected', desiredMode: 'remote', activeHostId: 'a', connectionDurationMs: 1234 }));
  assert.match(f.get('status-description').textContent, /연결 1\.2초/);
});
