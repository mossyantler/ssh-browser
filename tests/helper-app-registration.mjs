import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(root, 'scripts/register-helper-macos.sh');
const id = fs.readFileSync(path.join(root, 'extension/ID.txt'), 'utf8').trim();
const profiles = {chrome: 'Google/Chrome', chromium: 'Chromium', aside: 'Aside'};
function fixture(run, name = 'SSH Browser Helper.app') {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-browser-app-registration-'));
  const home = path.join(temp, 'home'), app = path.join(temp, name);
  fs.mkdirSync(home);
  fs.mkdirSync(path.join(app, 'Contents/MacOS'), {recursive: true});
  fs.mkdirSync(path.join(app, 'Contents/Resources'));
  fs.writeFileSync(path.join(app, 'Contents/Info.plist'), '<plist><dict/></plist>');
  // Executable fixture copied into the bundle, never executed by registration.
  const host = path.join(app, 'Contents/MacOS/ssh-browser-native-host');
  fs.writeFileSync(host, '#!/bin/sh\necho unexpected-native-execution >&2\nexit 99\n', {mode: 0o755});
  fs.writeFileSync(path.join(app, 'Contents/Resources/extension-id.txt'), id + '\n');
  const manifest = browser => path.join(home, 'Library/Application Support', profiles[browser], 'NativeMessagingHosts/com.sshbrowser.helper.json');
  const call = (args = [], extraEnv = {}) => spawnSync('/bin/bash', [script, '--app', app, ...args], {
    env: {...process.env, HOME: home, ...extraEnv}, encoding: 'utf8', timeout: 5000,
  });
  try { run({temp, home, app, host, manifest, call}); }
  finally { fs.rmSync(temp, {recursive: true, force: true}); }
}
function ok(result) { assert.equal(result.error, undefined); assert.equal(result.status, 0, result.stderr); }

test('Chrome registration updates legacy path idempotently while preserving all existing files', () => fixture(f => {
  const originals = {
    '.ssh/config': 'Host keep\n', '.ssh/known_hosts': 'keep',
    'Library/Application Support/SSH Browser/bin/ssh-browser-helper': 'old binary remains',
    'Library/Application Support/SSH Browser/extension/manifest.json': 'old extension remains',
    'Library/Application Support/Google/Chrome/Default/Preferences': '{"preserve":true}',
    'Library/Application Support/Google/Chrome/NativeMessagingHosts/com.other.helper.json': 'other helper remains',
  };
  for (const [file, contents] of Object.entries(originals)) {
    const target = path.join(f.home, file); fs.mkdirSync(path.dirname(target), {recursive: true}); fs.writeFileSync(target, contents);
  }
  fs.writeFileSync(f.manifest('chrome'), '{"path":"/old/helper"}');
  ok(f.call());
  const first = fs.readFileSync(f.manifest('chrome'), 'utf8');
  const manifest = JSON.parse(first);
  assert.equal(manifest.path, path.join(fs.realpathSync(f.app), 'Contents/MacOS/ssh-browser-native-host'));
  assert.equal(manifest.name, 'com.sshbrowser.helper');
  assert.equal(manifest.type, 'stdio');
  assert.deepEqual(manifest.allowed_origins, [`chrome-extension://${id}/`]);
  assert.equal(fs.statSync(f.manifest('chrome')).mode & 0o777, 0o600);
  ok(f.call()); assert.equal(fs.readFileSync(f.manifest('chrome'), 'utf8'), first);
  for (const [file, contents] of Object.entries(originals)) assert.equal(fs.readFileSync(path.join(f.home, file), 'utf8'), contents);
  assert.ok(!fs.existsSync(f.manifest('chromium')) && !fs.existsSync(f.manifest('aside')));
  assert.ok(!fs.readdirSync(path.dirname(f.manifest('chrome'))).some(n => n.startsWith('.ssh-browser.')));
  assert.match(fs.readFileSync(f.host, 'utf8'), /unexpected-native-execution/);
}));

test('native manifest JSON escapes Unicode, quotes, backslashes and control characters in app path', () => fixture(f => {
  ok(f.call());
  const manifest = JSON.parse(fs.readFileSync(f.manifest('chrome'), 'utf8'));
  assert.equal(manifest.path, path.join(fs.realpathSync(f.app), 'Contents/MacOS/ssh-browser-native-host'));
}, '한글 "quoted" \\ tab\tline\n\x01\x1f Helper.app'));

test('CLI selects individual browsers or all and supports explicit extension ID', () => fixture(f => {
  ok(f.call(['--browser', 'aside', '--extension-id', 'b'.repeat(32)]));
  assert.ok(!fs.existsSync(f.manifest('chrome')));
  assert.deepEqual(JSON.parse(fs.readFileSync(f.manifest('aside'))).allowed_origins, [`chrome-extension://${'b'.repeat(32)}/`]);
  ok(f.call(['--browser', 'chromium']));
  assert.ok(!fs.existsSync(f.manifest('chrome')));
  ok(f.call(['--browser', 'all']));
  for (const browser of Object.keys(profiles)) assert.deepEqual(JSON.parse(fs.readFileSync(f.manifest(browser))).allowed_origins, [`chrome-extension://${id}/`]);
}));

test('invalid app, extension ID, browser and relative HOME fail before creating registration paths', () => fixture(f => {
  for (const args of [['--app', '/missing/Helper.app'], ['--extension-id', 'bad'], ['--browser', 'safari'], ['--extension-id']]) {
    const out = f.call(args); assert.notEqual(out.status, 0); assert.equal(out.error, undefined);
    assert.ok(!fs.existsSync(path.join(f.home, 'Library')));
  }
  assert.notEqual(f.call([], {HOME: 'relative-home'}).status, 0);
  assert.ok(!fs.existsSync(path.join(f.home, 'Library')));
  fs.rmSync(f.host);
  assert.notEqual(f.call().status, 0); assert.ok(!fs.existsSync(path.join(f.home, 'Library')));
}));

test('non-file and symlink manifest targets are refused without touching their contents', () => fixture(f => {
  const target = f.manifest('chrome');
  fs.mkdirSync(target, {recursive: true});
  fs.writeFileSync(path.join(target, 'keep'), 'untouched');
  assert.notEqual(f.call().status, 0);
  assert.equal(fs.readFileSync(path.join(target, 'keep'), 'utf8'), 'untouched');
  fs.rmSync(target, {recursive: true});
  const other = path.join(f.temp, 'other-manifest'); fs.writeFileSync(other, 'untouched'); fs.symlinkSync(other, target);
  assert.notEqual(f.call().status, 0); assert.equal(fs.readFileSync(other, 'utf8'), 'untouched');
  fs.unlinkSync(target);
  fs.rmSync(path.dirname(target), {recursive: true});
  const otherDirectory = path.join(f.temp, 'other-directory'); fs.mkdirSync(otherDirectory);
  fs.symlinkSync(otherDirectory, path.dirname(target));
  assert.notEqual(f.call().status, 0); assert.deepEqual(fs.readdirSync(otherDirectory), []);
}));
