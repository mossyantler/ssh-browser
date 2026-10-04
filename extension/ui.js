import { validateHost } from './core.js';
const $ = (id) => document.getElementById(id);
const popup = document.body.dataset.view === 'popup';
const runtime = globalThis.chrome?.runtime;
const preview = !runtime?.id;
const incognito = !preview && Boolean(globalThis.chrome?.extension?.inIncognitoContext);
const PREVIEW_KEY = 'ssh-browser-ui-preview-v1';
let state = { hosts: [], status: 'disabled', activeHostId: null, error: null, helperVersion: null, proxyControlled: false };
let selectedId = null;
let filter = 'all';
let search = '';
let editingId = null;
let busy = false;
let refreshPending = false;
let operationError = '';
let toastTimer;
let pollTimer;
let renderSignature = '';
const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = String(text);
  return node;
};
const button = (text, className, action, label) => {
  const node = el('button', className, text);
  node.type = 'button';
  if (label) node.setAttribute('aria-label', label);
  node.addEventListener('click', (event) => { event.stopPropagation(); action(event); });
  return node;
};
function toast(message) {
  clearTimeout(toastTimer);
  $('toast').textContent = message;
  $('toast').hidden = false;
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, 5500);
}
function errorMessage(error) {
  const message = typeof error === 'string' ? error : error?.message || '요청을 처리하지 못했습니다.';
  if (/native|helper|com\.sshbrowser|specified.*host|receiving end/i.test(message)) {
    return `SSH 도우미에 연결하지 못했습니다. macOS 도우미 설치와 Chrome 확장 연결을 확인해 주세요. (${message})`;
  }
  return message;
}
function previewRequest(message) {
  let hosts;
  try {
    const saved = JSON.parse(localStorage.getItem(PREVIEW_KEY) || '[]');
    hosts = Array.isArray(saved) ? saved.filter((host) => host && typeof host.id === 'string' && typeof host.name === 'string') : [];
  } catch { throw new Error('미리보기 저장소를 읽지 못했습니다. 브라우저의 로컬 저장소 허용 여부를 확인해 주세요.'); }
  if (message.type === 'SAVE_HOST') {
    const index = hosts.findIndex((host) => host.id === message.host.id);
    if (index < 0) hosts.push(message.host); else hosts[index] = message.host;
  } else if (message.type === 'DELETE_HOST') hosts = hosts.filter((host) => host.id !== message.id);
  else if (['CONNECT', 'LOCAL', 'STOP'].includes(message.type)) {
    throw new Error('UI 미리보기에서는 실제 SSH 연결이나 프록시 변경을 지원하지 않습니다. Chrome에 확장 프로그램과 macOS 도우미를 설치한 뒤 사용해 주세요.');
  }
  if (message.type !== 'GET_STATE') {
    try { localStorage.setItem(PREVIEW_KEY, JSON.stringify(hosts)); }
    catch { throw new Error('미리보기 호스트를 저장하지 못했습니다. 로컬 저장소 설정이나 남은 공간을 확인해 주세요.'); }
  }
  return { ok: true, state: { ...state, hosts, status: 'disabled', activeHostId: null, error: null, proxyControlled: false } };
}
async function request(message) {
  if (incognito) throw new Error('시크릿 모드에서는 사용할 수 없습니다.');
  if (preview) return previewRequest(message);
  let timeout;
  try {
    return await Promise.race([
      runtime.sendMessage(message),
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('응답 시간이 초과되었습니다. 도우미 상태와 네트워크를 확인해 주세요.')), 45000); }),
    ]);
  } finally { clearTimeout(timeout); }
}
function accept(reply) {
  if (reply?.state) state = { ...state, ...reply.state, hosts: Array.isArray(reply.state.hosts) ? reply.state.hosts : state.hosts };
  if (!reply?.ok) throw new Error(reply?.error || '확장 프로그램에서 유효한 응답을 받지 못했습니다.');
}
async function refresh() {
  if (incognito || busy || refreshPending) return;
  refreshPending = true;
  try { accept(await request({ type: 'GET_STATE' })); }
  catch (error) { operationError = errorMessage(error); }
  finally { refreshPending = false; render(); }
}
async function mutate(message, successMessage = '') {
  if (busy || incognito) return false;
  busy = true;
  operationError = '';
  render();
  try {
    accept(await request(message));
    if (successMessage) toast(successMessage);
    return true;
  } catch (error) {
    operationError = errorMessage(error);
    toast(operationError);
    return false;
  } finally { busy = false; render(); }
}
function address(host) {
  return host.mode === 'alias' ? host.alias || 'SSH config 별칭' : `${host.user ? `${host.user}@` : ''}${host.address || ''}:${host.port || 22}`;
}
function connect(host) { selectedId = host.id; void mutate({ type: 'CONNECT', id: host.id }); }
function statusCopy() {
  const activeHost = state.hosts.find((host) => host.id === state.activeHostId);
  if (preview) return ['UI 미리보기', '실제 연결 없음', '호스트 설정만 이 브라우저에 저장됩니다. 네트워크 경로는 변경하지 않습니다.'];
  const descriptions = {
    local: ['로컬 직접 연결', 'DIRECT', 'SSH 프록시 없이 브라우저가 직접 연결하도록 설정했습니다.'],
    connecting: ['SSH 연결 중', '연결 준비', '인증과 터널 준비를 기다리고 있습니다. 연결 완료 전에는 경로를 사용할 수 없습니다.'],
    connected: [activeHost?.name || 'SSH 호스트', 'SSH 연결됨', `${activeHost ? address(activeHost) + ' · ' : ''}선택한 SSH 터널을 브라우저 경로로 사용합니다.`],
    error: ['연결을 확인해 주세요', '연결 오류', '직접 연결로 자동 전환하지 않습니다. 다시 연결하거나 로컬 직접 연결을 선택해 주세요.'],
    disabled: ['기존 프록시 설정 사용', '제어 해제', '확장 기능의 제어가 해제되었습니다. 운영체제·정책·다른 확장의 기존 설정이 적용됩니다.'],
  };
  return descriptions[state.status] || ['상태 확인 중', '확인 중', '현재 브라우저 경로를 확인합니다.'];
}
function renderStatus() {
  const [title, pill, description] = statusCopy();
  $('status-title').textContent = title;
  $('status-pill').textContent = pill;
  $('status-pill').dataset.status = preview ? 'disabled' : state.status;
  $('status-description').textContent = description;
  const error = operationError || (state.error ? errorMessage(state.error) : '');
  $('error-panel').hidden = !error;
  $('error-text').textContent = error;
  $('local-button').disabled = busy || (!preview && state.status === 'connecting');
  $('stop-button').disabled = busy;
  if ($('helper-version')) $('helper-version').textContent = state.helperVersion ? `도우미 v${state.helperVersion}` : 'SSH Browser v0.1';
}
function renderGroups() {
  const groups = [...new Set(state.hosts.map((host) => host.group).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ko'));
  $('all-count').textContent = state.hosts.length;
  $('favorite-count').textContent = state.hosts.filter((host) => host.favorite).length;
  $('group-count').textContent = groups.length;
  $('no-groups').hidden = Boolean(groups.length);
  const fragment = document.createDocumentFragment();
  const suggestions = document.createDocumentFragment();
  for (const group of groups) {
    const node = button('', `nav-item${filter === `group:${group}` ? ' active' : ''}`, () => setFilter(`group:${group}`));
    node.append(el('span', 'group-dot'), el('span', '', group), el('span', 'count', state.hosts.filter((host) => host.group === group).length));
    node.setAttribute('aria-pressed', String(filter === `group:${group}`));
    fragment.append(node);
    const option = el('option'); option.value = group; suggestions.append(option);
  }
  $('group-list').replaceChildren(fragment);
  $('group-suggestions').replaceChildren(suggestions);
  document.querySelectorAll('[data-filter]').forEach((node) => {
    node.classList.toggle('active', node.dataset.filter === filter);
    node.setAttribute('aria-pressed', String(node.dataset.filter === filter));
  });
  const title = filter === 'all' ? '모든 호스트' : filter === 'favorites' ? '즐겨찾기' : filter.slice(6);
  $('page-title').replaceChildren(document.createTextNode(title), el('span', 'title-dot', '.'));
}
function visibleHosts() {
  return state.hosts.filter((host) => (filter === 'all' || (filter === 'favorites' ? host.favorite : host.group === filter.slice(6))) &&
    [host.name, host.group, host.alias, host.address, host.user].filter(Boolean).join(' ').toLocaleLowerCase().includes(search.toLocaleLowerCase()))
    .sort((a, b) => Number(Boolean(b.favorite)) - Number(Boolean(a.favorite)) || a.name.localeCompare(b.name, 'ko'));
}
function hostCard(host) {
  const active = state.status === 'connected' && state.activeHostId === host.id;
  const card = el('article', `host-card${selectedId === host.id ? ' selected' : ''}`);
  card.tabIndex = 0;
  card.setAttribute('aria-label', `${host.name} 상세 보기`);
  const select = () => { selectedId = host.id; renderSignature = ''; render(); };
  card.addEventListener('click', select);
  card.addEventListener('keydown', (event) => { if (event.target === card && ['Enter', ' '].includes(event.key)) { event.preventDefault(); select(); } });
  const top = el('div', 'card-top');
  const favorite = button(host.favorite ? '★' : '☆', `icon-button favorite-button${host.favorite ? ' on' : ''}`, () => void mutate({ type: 'SAVE_HOST', host: { ...host, favorite: !host.favorite } }), `${host.name} 즐겨찾기 ${host.favorite ? '해제' : '추가'}`);
  favorite.disabled = busy;
  favorite.setAttribute('aria-pressed', String(Boolean(host.favorite)));
  top.append(el('span', 'host-icon', '>_'), favorite);
  const bottom = el('div', 'card-bottom');
  const connectButton = button(active ? '사용 중 ✓' : '연결하기 ↗', active ? 'card-connect card-active' : 'card-connect', () => connect(host));
  connectButton.disabled = busy || active;
  bottom.append(el('span', 'group-tag', host.group || '그룹 없음'), connectButton);
  card.append(top, el('h2', '', host.name), el('div', 'host-address', address(host)), bottom);
  return card;
}
function renderDetails() {
  const container = $('host-details');
  const host = state.hosts.find((candidate) => candidate.id === selectedId);
  if (!host) {
    const empty = el('div', 'detail-placeholder');
    empty.append(el('span', 'host-icon', '>_'), el('h2', '', '연결을 위한 작은 공간'), el('p', '', '호스트를 선택하면 접속 정보와\n연결 옵션을 여기서 확인할 수 있어요.'));
    container.replaceChildren(empty); return;
  }
  const list = el('dl', 'detail-list');
  const values = [['그룹', host.group || '그룹 없음'], [host.mode === 'alias' ? 'SSH 별칭' : '서버 주소', host.mode === 'alias' ? host.alias : host.address]];
  if (host.mode === 'manual') values.push(['포트', host.port || 22], ['사용자', host.user || 'SSH 기본 설정'], ['개인 키 경로', host.keyPath || 'SSH 기본 인증 설정']);
  for (const [label, value] of values) { const row = el('div'); row.append(el('dt', '', label), el('dd', label === '그룹' ? '' : 'mono', value)); list.append(row); }
  const active = state.status === 'connected' && state.activeHostId === host.id;
  const connectButton = button(active ? '현재 사용 중' : '이 호스트로 연결 ↗', 'button primary full-width', () => connect(host));
  connectButton.disabled = busy || active;
  const actions = el('div', 'detail-actions');
  const edit = button('호스트 편집', 'text-button', () => openDialog(host));
  const remove = button('삭제', 'text-button danger', () => deleteHost(host));
  edit.disabled = busy; remove.disabled = busy;
  actions.append(edit, remove);
  container.replaceChildren(el('div', 'host-icon detail-avatar', '>_'), el('h2', 'detail-name', host.name), el('span', 'detail-mode', host.mode === 'alias' ? 'SSH CONFIG ALIAS' : 'MANUAL CONNECTION'), list, connectButton, actions);
}
function renderPopup(hosts) {
  const fragment = document.createDocumentFragment();
  for (const host of hosts) {
    const active = state.status === 'connected' && state.activeHostId === host.id;
    const node = button('', `popup-host${active ? ' active' : ''}`, () => connect(host), `${host.name}${active ? ' 사용 중' : ' 연결'}`);
    node.disabled = busy || active;
    const copy = el('span', 'popup-host-copy'); copy.append(el('strong', '', `${host.favorite ? '☆ ' : ''}${host.name}`), el('small', '', address(host)));
    node.append(el('span', 'host-icon', '>_'), copy, el('span', 'switch-arrow', active ? '✓' : '↗'));
    fragment.append(node);
  }
  $('popup-host-list').replaceChildren(fragment);
  $('empty-state').hidden = hosts.length > 0;
  if (!hosts.length) {
    $('empty-state').replaceChildren(document.createTextNode(state.hosts.length ? '검색 결과가 없습니다.' : '아직 저장된 호스트가 없습니다.'), el('br'), button('호스트 관리 열기 ↗', 'text-button', openSettings));
  }
}
function render() {
  if (incognito) return;
  renderStatus();
  const signature = JSON.stringify([state.hosts, state.status, state.activeHostId, selectedId, filter, search, busy]);
  if (renderSignature === signature) return;
  renderSignature = signature;
  if (selectedId && !state.hosts.some((host) => host.id === selectedId)) selectedId = null;
  const hosts = visibleHosts();
  $('result-count').textContent = popup ? String(hosts.length) : `${hosts.length}개의 호스트`;
  if (popup) { renderPopup(hosts); return; }
  renderGroups();
  $('host-grid').replaceChildren(...hosts.map(hostCard));
  $('empty-state').hidden = hosts.length > 0;
  const first = state.hosts.length === 0;
  $('empty-title').textContent = first ? '첫 번째 경로를 추가하세요' : '해당하는 호스트가 없습니다';
  $('empty-description').textContent = first ? 'SSH config의 별칭이나 서버 주소로 나만의 호스트 목록을 만들어 보세요.' : '다른 검색어를 입력하거나 새로운 호스트를 추가해 보세요.';
  $('empty-add').textContent = first ? '＋ 첫 호스트 추가' : '＋ 호스트 추가';
  $('add-host').disabled = busy;
  $('empty-add').disabled = busy;
  $('save-host').disabled = busy;
  renderDetails();
}
function setFilter(value) { filter = value; render(); }
function updateMode() {
  const manual = document.querySelector('input[name=mode]:checked').value === 'manual';
  $('manual-fields').hidden = !manual;
  $('alias-fields').hidden = manual;
  $('host-alias').required = !manual;
  $('host-address').required = manual;
  for (const name of ['address', 'port', 'user', 'keyPath']) $(`host-${name}`).disabled = !manual;
  $('host-alias').disabled = manual;
}
function openDialog(host = null) {
  editingId = host?.id || null;
  $('host-form').reset();
  $('dialog-title').textContent = host ? '호스트 편집' : '새 호스트 추가';
  $('form-error').hidden = true;
  for (const name of ['name', 'group', 'alias', 'address', 'user', 'keyPath']) $(`host-${name}`).value = host?.[name] || '';
  $('host-port').value = host?.port || 22;
  $('host-favorite').checked = Boolean(host?.favorite);
  document.querySelector(`input[name=mode][value=${host?.mode === 'manual' ? 'manual' : 'alias'}]`).checked = true;
  updateMode();
  $('host-dialog').showModal();
  $('host-name').focus();
}
async function saveHost(event) {
  event.preventDefault();
  const mode = document.querySelector('input[name=mode]:checked').value;
  const value = (name) => $(`host-${name}`).value.trim();
  const host = { id: editingId || crypto.randomUUID(), name: value('name'), group: value('group'), favorite: $('host-favorite').checked, mode, alias: mode === 'alias' ? value('alias') : '', address: mode === 'manual' ? value('address') : '', port: mode === 'manual' ? Number(value('port') || 22) : 22, user: mode === 'manual' ? value('user') : '', keyPath: mode === 'manual' ? value('keyPath') : '' };
  let validation = '';
  if (!host.name) validation = '호스트 이름을 입력해 주세요.';
  else if (mode === 'alias' && (!host.alias || /^[\s-]|\s/.test(host.alias))) validation = 'SSH 별칭에는 공백을 사용할 수 없으며 하이픈으로 시작할 수 없습니다.';
  else if (mode === 'manual' && (!host.address || /\s|:\/\//.test(host.address) || host.address.startsWith('-'))) validation = '서버 주소만 입력해 주세요. 프로토콜과 공백은 포함하지 않습니다.';
  else if (host.user && (/\s/.test(host.user) || host.user.startsWith('-'))) validation = '사용자 이름에 공백이나 시작 하이픈을 사용할 수 없습니다.';
  else if (!Number.isInteger(host.port) || host.port < 1 || host.port > 65535) validation = '포트는 1부터 65535 사이여야 합니다.';
  else if (host.keyPath && !host.keyPath.startsWith('/')) validation = '개인 키 경로는 /로 시작하는 절대 경로여야 합니다.';
  if (!validation) { try { validateHost(host); } catch (error) { validation = error.message; } }
  if (validation) { $('form-error').textContent = validation; $('form-error').hidden = false; return; }
  const saved = await mutate({ type: 'SAVE_HOST', host }, editingId ? '호스트 정보를 수정했습니다.' : '호스트를 추가했습니다.');
  if (saved) { selectedId = host.id; $('host-dialog').close(); render(); }
  else { $('form-error').textContent = operationError; $('form-error').hidden = false; }
}
function confirmDelete(host) {
  return new Promise(resolve => {
    const dialog = el('dialog');
    dialog.setAttribute('aria-labelledby', 'delete-title');
    const title = el('h2', '', '호스트 삭제'); title.id = 'delete-title';
    const description = el('p', 'dialog-intro', `“${host.name}”의 저장된 접속 정보를 삭제할까요? 이 작업은 서버나 SSH 키 파일을 삭제하지 않습니다.`);
    let settled = false;
    const finish = value => { if (settled) return; settled = true; if (dialog.open) dialog.close(); dialog.remove(); resolve(value); };
    const actions = el('footer', 'dialog-footer');
    const cancel = button('취소', 'button secondary', () => finish(false));
    actions.append(cancel, button('삭제 확인', 'button secondary danger', () => finish(true)));
    dialog.append(title, description, actions);
    dialog.addEventListener('cancel', event => { event.preventDefault(); finish(false); });
    dialog.addEventListener('close', () => finish(false));
    document.body.append(dialog); dialog.showModal(); cancel.focus();
  });
}
async function deleteHost(host) {
  if (!await confirmDelete(host)) return;
  await mutate({ type: 'DELETE_HOST', id: host.id }, '호스트를 삭제했습니다.');
}
function openSettings(event) {
  event?.preventDefault();
  if (preview) location.href = 'options.html';
  else Promise.resolve(runtime.openOptionsPage()).catch((error) => toast(errorMessage(error)));
}
$('preview-banner').hidden = !preview;
$('incognito-warning').hidden = !incognito;
$('app').hidden = incognito;
if (!incognito) {
  $('search').addEventListener('input', (event) => { search = event.target.value.trim(); render(); });
  $('local-button').addEventListener('click', () => void mutate({ type: 'LOCAL' }));
  $('stop-button').addEventListener('click', () => void mutate({ type: 'STOP' }));
  $('retry-state').addEventListener('click', () => { operationError = ''; void refresh(); });
  if (popup) {
    $('open-settings').addEventListener('click', openSettings);
    $('popup-brand').addEventListener('click', openSettings);
    $('empty-add').addEventListener('click', openSettings);
  } else {
    $('add-host').addEventListener('click', () => openDialog());
    $('empty-add').addEventListener('click', () => openDialog());
    $('close-dialog').addEventListener('click', () => $('host-dialog').close());
    $('cancel-dialog').addEventListener('click', () => $('host-dialog').close());
    $('host-form').addEventListener('submit', saveHost);
    document.querySelectorAll('input[name=mode]').forEach((node) => node.addEventListener('change', updateMode));
    document.querySelectorAll('[data-filter]').forEach((node) => node.addEventListener('click', () => setFilter(node.dataset.filter)));
    document.addEventListener('keydown', (event) => {
      if (event.key === '/' && !['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName) && !$('host-dialog').open) { event.preventDefault(); $('search').focus(); }
    });
  }
  void refresh();
  pollTimer = setInterval(() => { if (!document.hidden) void refresh(); }, 1750);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void refresh(); });
  window.addEventListener('storage', (event) => { if (preview && event.key === PREVIEW_KEY) void refresh(); });
  window.addEventListener('pagehide', () => { clearInterval(pollTimer); clearTimeout(toastTimer); });
  window.addEventListener('pageshow', (event) => { if (event.persisted) { clearInterval(pollTimer); pollTimer = setInterval(() => { if (!document.hidden) void refresh(); }, 1750); void refresh(); } });
}
