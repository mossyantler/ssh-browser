import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const id = fs.readFileSync(path.join(root, 'extension/ID.txt'), 'utf8').trim();
const profiles = {chrome: 'Google/Chrome', chromium: 'Chromium', aside: 'Aside'};
function fixture(run, {arch = 'arm64', homeName = 'home'} = {}) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-browser-install-fixture-'));
  const home = path.join(temp, homeName), payload = path.join(temp, 'payload'), tools = path.join(temp, 'tools');
  fs.mkdirSync(home); fs.mkdirSync(tools);
  fs.mkdirSync(path.join(payload, 'bin'), {recursive: true});
  // This development CLI consumes only extension-ID metadata, never extension payloads.
  fs.mkdirSync(path.join(payload, 'extension'));
  fs.writeFileSync(path.join(payload, 'extension/ID.txt'), id);
  // These are deliberately not executable programs. Installer must only copy them.
  for (const cpu of ['arm64', 'amd64']) fs.writeFileSync(path.join(payload, 'bin', 'ssh-browser-helper-darwin-' + cpu), 'fixture-' + cpu);
  fs.writeFileSync(path.join(tools, 'uname'), `#!/bin/sh\ncase "$1" in -s) echo Darwin;; -m) echo ${arch};; esac\n`, {mode: 0o755});
  const env = {...process.env, HOME: home, PATH: tools + path.delimiter + process.env.PATH};
  const support = path.join(home, 'Library/Application Support');
  const dest = path.join(support, 'SSH Browser');
  const manifestPath = browser => path.join(support, profiles[browser], 'NativeMessagingHosts/com.sshbrowser.helper.json');
  const call = (script, args = []) => spawnSync('/bin/bash', [path.join(root, 'scripts', script + '-macos.sh'), ...args], {env, encoding: 'utf8'});
  const install = (...args) => call('install', ['--payload-dir', payload, ...args]);
  const uninstall = (...args) => call('uninstall', args);
  try { run({temp, home, payload, tools, env, dest, manifestPath, install, uninstall}); }
  finally { fs.rmSync(temp, {recursive: true, force: true}); }
}
function ok(out) { assert.equal(out.status, 0, out.stdout + out.stderr); }
function snapshot(file) {
  const stat=fs.lstatSync(file);
  const result={mode:stat.mode,ino:stat.ino,mtimeMs:stat.mtimeMs,ctimeMs:stat.ctimeMs};
  if(stat.isSymbolicLink()) result.target=fs.readlinkSync(file);
  else if(stat.isDirectory()) result.children=Object.fromEntries(fs.readdirSync(file).sort().map(name=>[name,snapshot(path.join(file,name))]));
  else result.content=fs.readFileSync(file).toString('base64');
  return result;
}
function preservedExtension(f, owned=true) {
  const extension=path.join(f.dest,'extension'),marker=path.join(f.dest,'.extension-installed-by-ssh-browser');
  fs.mkdirSync(extension,{recursive:true});
  fs.writeFileSync(path.join(extension,'manifest.json'),'{"userExtension":"preserve"}');
  fs.writeFileSync(path.join(extension,'.extension-installed-by-ssh-browser'),'nested legacy marker');
  fs.writeFileSync(marker,owned?'ssh-browser-extension-v1\n':'user-owned marker\n');
  fs.chmodSync(extension,0o750);fs.chmodSync(marker,0o640);
  const before={extension:snapshot(extension),marker:snapshot(marker)};
  return ()=>assert.deepEqual({extension:snapshot(extension),marker:snapshot(marker)},before,'extension tree and marker must remain untouched');
}
function replacementFailure(f, sourcePattern) {
  fs.writeFileSync(path.join(f.tools,'mv'),`#!/bin/bash\nsource="$1"\n[ "$source" != -f ] || source="$2"\ncase "$source" in ${sourcePattern}) echo 'fixture replacement failure' >&2; exit 1;; esac\nexec /bin/mv "$@"\n`,{mode:0o755});
}
const alternateId=id==='a'.repeat(32)?'b'.repeat(32):'a'.repeat(32);
for (const browser of Object.keys(profiles)) {
  test(`helper-only ${browser} install/uninstall preserves an old combined extension and marker`, () => fixture(f => {
    const unchanged=preservedExtension(f);
    fs.mkdirSync(path.join(f.home, '.ssh'));
    fs.writeFileSync(path.join(f.home, '.ssh/config'), 'preserve SSH config');
    fs.writeFileSync(path.join(f.home, '.ssh/known_hosts'), 'preserve known hosts');
    fs.writeFileSync(path.join(f.home, '.ssh/id_ed25519'), 'fixture key, never read by CLI');
    fs.mkdirSync(path.dirname(f.manifestPath(browser)), {recursive: true});
    const unrelated = path.join(path.dirname(f.manifestPath(browser)), 'com.other.helper.json');
    fs.writeFileSync(unrelated, '{"untouched":true}');
    const out = f.install('--browser', browser); ok(out);
    const manifest = JSON.parse(fs.readFileSync(f.manifestPath(browser), 'utf8'));
    assert.equal(manifest.path, path.join(f.dest, 'bin/ssh-browser-helper'));
    assert.equal(fs.readFileSync(manifest.path, 'utf8'), 'fixture-arm64');
    assert.deepEqual(manifest.allowed_origins, [`chrome-extension://${id}/`]);
    assert.equal(fs.statSync(manifest.path).mode & 0o777, 0o755);
    assert.equal(fs.statSync(f.manifestPath(browser)).mode & 0o777, 0o600);
    unchanged();
    fs.renameSync(f.payload, f.payload + '-moved');
    assert.ok(fs.existsSync(manifest.path),'moving build output cannot break the registered helper');
    assert.doesNotMatch(out.stdout,/Load unpacked|chrome:\/\/extensions|Extension folder:/);
    ok(f.uninstall('--browser', browser));
    assert.ok(!fs.existsSync(manifest.path));unchanged();
    assert.equal(fs.readFileSync(unrelated, 'utf8'), '{"untouched":true}');
    assert.equal(fs.readFileSync(path.join(f.home, '.ssh/config'), 'utf8'), 'preserve SSH config');
    assert.equal(fs.readFileSync(path.join(f.home, '.ssh/known_hosts'),'utf8'),'preserve known hosts');
    assert.equal(fs.readFileSync(path.join(f.home, '.ssh/id_ed25519'),'utf8'),'fixture key, never read by CLI');
  }));
}
test('shared helper remains until the last browser is removed, while extension stays untouched', () => fixture(f => {
  const unchanged=preservedExtension(f);
  ok(f.install('--browser', 'all'));
  const binary = path.join(f.dest, 'bin/ssh-browser-helper');unchanged();
  for (const browser of ['chrome', 'chromium']) {
    ok(f.uninstall('--browser', browser));
    assert.ok(!fs.existsSync(f.manifestPath(browser)));
    assert.ok(fs.existsSync(binary));unchanged();
  }
  assert.ok(fs.existsSync(f.manifestPath('aside')));
  ok(f.uninstall('--browser', 'aside')); assert.ok(!fs.existsSync(binary));unchanged();
}));
test('all-browser uninstall and repeated uninstall leave unrelated files intact', () => fixture(f => {
  const unchanged=preservedExtension(f);
  const app=path.join(f.home,'Applications/SSH Browser Helper.app'),profile=path.join(f.home,'Library/Application Support/Google/Chrome/Default');
  for(const folder of [app,profile]) {fs.mkdirSync(folder,{recursive:true});fs.writeFileSync(path.join(folder,'keep'),'user-owned data');}
  const untouched={app:snapshot(app),profile:snapshot(profile)};
  ok(f.install('--browser', 'all'));
  fs.writeFileSync(path.join(f.dest, 'user-file'), 'keep');
  ok(f.uninstall('--browser', 'all')); ok(f.uninstall('--browser', 'all'));
  for (const browser of Object.keys(profiles)) assert.ok(!fs.existsSync(f.manifestPath(browser)));
  assert.equal(fs.readFileSync(path.join(f.dest, 'user-file'), 'utf8'), 'keep');
  unchanged();
  fs.mkdirSync(path.join(f.dest,'bin'),{recursive:true});
  fs.writeFileSync(path.join(f.dest,'bin/ssh-browser-helper'),'unowned helper');
  ok(f.uninstall('--browser','all'));
  assert.equal(fs.readFileSync(path.join(f.dest,'bin/ssh-browser-helper'),'utf8'),'unowned helper');
  assert.deepEqual({app:snapshot(app),profile:snapshot(profile)},untouched);
}));
test('JSON escapes quotes, backslashes, tabs, newlines and Unicode in HOME', () => fixture(f => {
  ok(f.install('--browser', 'all'));
  for (const browser of Object.keys(profiles)) {
    const manifest = JSON.parse(fs.readFileSync(f.manifestPath(browser), 'utf8'));
    assert.equal(manifest.path, path.join(f.dest, 'bin/ssh-browser-helper'));
    assert.ok(fs.existsSync(manifest.path));
  }
}, {homeName: '한글 "quoted" \\ path\tline\nend'}));
test('Intel fixture picks amd64 helper', () => fixture(f => {
  ok(f.install()); assert.equal(fs.readFileSync(path.join(f.dest, 'bin/ssh-browser-helper'), 'utf8'), 'fixture-amd64');
}, {arch: 'x86_64'}));
test('helper-only update needs no extension manifest and keeps the stable binary path', () => fixture(f => {
  const unchanged=preservedExtension(f);
  ok(f.install());
  fs.rmSync(path.join(f.payload,'extension'),{recursive:true});
  fs.writeFileSync(path.join(f.payload,'bin/ssh-browser-helper-darwin-arm64'),'new helper');
  ok(f.install('--extension-id',alternateId));
  assert.equal(fs.readFileSync(path.join(f.dest,'bin/ssh-browser-helper'),'utf8'),'new helper');
  assert.deepEqual(JSON.parse(fs.readFileSync(f.manifestPath('chrome'))).allowed_origins,[`chrome-extension://${alternateId}/`]);
  unchanged();
  assert.ok(!fs.readdirSync(f.dest).some(n => n.startsWith('.install.')));
}));
test('invalid ID, unsupported browser, missing option and missing helper fail without installation', () => fixture(f => {
  for (const args of [['--extension-id', 'bad'], ['--browser', 'safari'], ['--browser']]) {
    assert.notEqual(f.install(...args).status, 0); assert.ok(!fs.existsSync(f.dest));
  }
  fs.rmSync(path.join(f.payload, 'bin/ssh-browser-helper-darwin-arm64'));
  assert.notEqual(f.install().status, 0); assert.ok(!fs.existsSync(f.dest));
}));
test('symlink installation target is refused without overwriting target', () => fixture(f => {
  const other = path.join(f.temp, 'other'); fs.mkdirSync(other);
  fs.writeFileSync(path.join(other, 'keep'), 'untouched');
  fs.mkdirSync(path.dirname(f.dest), {recursive: true}); fs.symlinkSync(other, f.dest);
  assert.notEqual(f.install().status, 0);
  assert.equal(fs.readFileSync(path.join(other, 'keep'), 'utf8'), 'untouched');
}));
test('unowned extension directory and symlink marker do not block helper-only install or uninstall', () => fixture(f => {
  const unchanged=preservedExtension(f,false);ok(f.install());unchanged();ok(f.uninstall());unchanged();
  const marker=path.join(f.dest,'.extension-installed-by-ssh-browser'),target=path.join(f.temp,'extension-marker');
  fs.renameSync(marker,target);fs.symlinkSync(target,marker);
  const before={extension:snapshot(path.join(f.dest,'extension')),marker:snapshot(marker),target:snapshot(target)};
  ok(f.install());ok(f.uninstall());
  assert.deepEqual({extension:snapshot(path.join(f.dest,'extension')),marker:snapshot(marker),target:snapshot(target)},before);
}));

for (const kind of ['helper', 'manifest']) {
  test(`directory at ${kind} file destination cannot be reported as successful installation`, () => fixture(f => {
    const file = kind === 'helper' ? path.join(f.dest, 'bin/ssh-browser-helper') : f.manifestPath('chrome');
    fs.mkdirSync(file, {recursive: true});
    fs.writeFileSync(path.join(file, 'keep'), 'untouched');
    assert.notEqual(f.install().status, 0);
    assert.equal(fs.readFileSync(path.join(file, 'keep'), 'utf8'), 'untouched');
    assert.ok(!fs.existsSync(path.join(file, kind === 'helper' ? 'helper' : 'chrome.json')));
  }));
}
for (const failure of ['helper', 'manifest']) {
  test(`failed ${failure} replacement restores helper and registrations without touching extension`, () => fixture(f => {
    const unchanged=preservedExtension(f);
    ok(f.install('--browser', 'all'));
    const previous = Object.fromEntries(Object.keys(profiles).map(browser => [browser, fs.readFileSync(f.manifestPath(browser), 'utf8')]));
    fs.writeFileSync(path.join(f.payload, 'bin/ssh-browser-helper-darwin-arm64'), 'new-helper');
    // Fail exactly one commit operation, leaving real rollback operations available.
    const match = failure === 'helper' ? '*/helper' : '*/chromium.json';
    replacementFailure(f,match);
    const out = f.install('--browser', 'all','--extension-id',alternateId); assert.notEqual(out.status, 0); assert.match(out.stderr, /restoring previous/);
    unchanged();
    assert.equal(fs.readFileSync(path.join(f.dest, 'bin/ssh-browser-helper'), 'utf8'), 'fixture-arm64');
    for (const browser of Object.keys(profiles)) assert.equal(fs.readFileSync(f.manifestPath(browser), 'utf8'), previous[browser]);
    assert.ok(!fs.readdirSync(f.dest).some(n => n.startsWith('.install.')));
  }));
}

test('failed helper rollback keeps the previous binary backup and leaves extension untouched', () => fixture(f => {
  const unchanged=preservedExtension(f);ok(f.install('--browser','all'));
  fs.writeFileSync(path.join(f.payload,'bin/ssh-browser-helper-darwin-arm64'),'new helper');
  replacementFailure(f,'*/chromium.json');
  fs.writeFileSync(path.join(f.tools,'cp'),`#!/bin/bash\ncase "$2" in */previous-helper) echo 'fixture helper recovery failure' >&2; exit 1;; esac\nexec /bin/cp "$@"\n`,{mode:0o755});
  const result = f.install('--browser','all'); assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Recovery backups kept at:/);
  const stage = fs.readdirSync(f.dest).find(n => n.startsWith('.install.'));
  assert.ok(stage);
  assert.equal(fs.readFileSync(path.join(f.dest,stage,'previous-helper'),'utf8'),'fixture-arm64');unchanged();
}));

test('failed registration rollback keeps its backup and leaves extension untouched', () => fixture(f => {
  const unchanged=preservedExtension(f);ok(f.install('--browser','all'));
  const previous=fs.readFileSync(f.manifestPath('chrome'),'utf8');
  replacementFailure(f,'*/chromium.json');
  fs.writeFileSync(path.join(f.tools,'cp'),`#!/bin/bash\ncase "$2" in */chrome.previous) echo 'fixture registration recovery failure' >&2; exit 1;; esac\nexec /bin/cp "$@"\n`,{mode:0o755});
  const result = f.install('--browser','all','--extension-id',alternateId); assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Recovery backups kept at:/);
  const stage = fs.readdirSync(f.dest).find(n => n.startsWith('.install.'));
  assert.ok(stage);
  assert.equal(fs.readFileSync(path.join(f.dest,stage,'chrome.previous'),'utf8'),previous);unchanged();
}));
