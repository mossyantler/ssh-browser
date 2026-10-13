import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, existsSync, rmSync, statSync, readdirSync, cpSync, chmodSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const packageScript = join(root, 'scripts/package-macos.sh');
const extensionScript = join(root, 'scripts/package-extension.mjs');
const extensionId = key => createHash('sha256').update(Buffer.from(key, 'base64')).digest('hex').slice(0, 32)
  .replace(/[0-9a-f]/g, value => String.fromCharCode(97 + Number.parseInt(value, 16)));
function run(command, args, options = {}) {
  return spawnSync(command, args, { encoding: 'utf8', timeout: 180_000, ...options,
    env: { ...process.env, CODESIGN_IDENTITY: '-', ...options.env } });
}
function checked(command, args, options = {}) {
  const result = run(command, args, options);
  assert.equal(result.error, undefined, `${command}: ${result.error}`);
  assert.equal(result.status, 0, `${command}: ${result.stdout}\n${result.stderr}`);
  return result;
}

test('fixture package: standalone universal helper, separate stable-ID extension ZIP, signatures and no execution', { skip: process.platform !== 'darwin' }, () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'ssh-browser-package-fixture-'));
  try {
    const fixture = join(sandbox, 'payload source with spaces');
    const home = join(sandbox, 'isolated home');
    mkdirSync(home);
    for (const directory of ['bin', 'extension/vendor', 'scripts', 'prebuilt']) mkdirSync(join(fixture, directory), { recursive: true });
    const key = JSON.parse(readFileSync(join(root, 'extension/manifest.json'), 'utf8')).key;
    const expectedId = readFileSync(join(root, 'extension/ID.txt'), 'utf8');
    assert.equal(extensionId(key), expectedId.trim());
    writeFileSync(join(fixture, 'extension/manifest.json'), JSON.stringify({ manifest_version: 3, name: 'Fixture extension', version: '0.0.1', key }));
    writeFileSync(join(fixture, 'extension/ID.txt'), expectedId);
    writeFileSync(join(fixture, 'extension/vendor/fixture.css'), '/* separate vendor fixture */\n');
    const executionMarker = join(sandbox, 'APP_HELPER_OR_REGISTRATION_EXECUTED');
    const script = `#!/bin/bash\nprintf 'unexpected execution' > '${executionMarker}'\nexit 99\n`;
    for (const name of ['register-helper-macos.sh', 'install-macos.sh', 'uninstall-macos.sh']) writeFileSync(join(fixture, 'scripts', name), script, { mode: 0o755 });
    const buildMarker = join(fixture, 'build-invoked.txt');
    writeFileSync(join(fixture, 'scripts/build.sh'), `#!/bin/bash
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
printf '%s\\n' "$#" "$GO_BIN" > "$ROOT/build-invoked.txt"
exit 42
`, { mode: 0o755 });
    const cSource = join(sandbox, 'helper-fixture.c');
    writeFileSync(cSource, `#include <stdio.h>
int main(void) { FILE *f = fopen(${JSON.stringify(executionMarker)}, "w");
if (f) { fputs("unexpected native host execution", f); fclose(f); } return 99; }
`);
    const sdk = checked('/usr/bin/xcrun', ['--sdk', 'macosx', '--show-sdk-path']).stdout.trim();
    for (const [goArch, machArch] of [['arm64', 'arm64'], ['amd64', 'x86_64']]) {
      const binary = join(fixture, 'prebuilt', `ssh-browser-helper-darwin-${goArch}`);
      // Compile-only native-host stand-ins must never be launched.
      checked('/usr/bin/xcrun', ['clang', '-isysroot', sdk, '-target', `${machArch}-apple-macosx12.0`, cSource, '-o', binary]);
      copyFileSync(binary, join(fixture, 'bin', `ssh-browser-helper-darwin-${goArch}`));
    }
    const goSentinel = join(sandbox, 'go-must-not-run');
    writeFileSync(goSentinel, script, { mode: 0o755 });
    const options = { env: { HOME: home, GO_BIN: goSentinel, CODESIGN_IDENTITY: '-' } };
    const output = join(sandbox, 'packaged output with spaces');
    mkdirSync(output);
    const oldArtifact = join(output, 'SSH-Browser-Installer-macos-universal.zip');
    writeFileSync(oldArtifact, 'previous user artifact');
    // Exactly one real Swift packaging pipeline; all negative cases fail before compilation.
    const packaged = checked('/bin/bash', [packageScript, '--skip-helper', '--source-root', fixture, '--output', output], options);
    assert.match(packaged.stdout, /NOT notarized/);
    assert.equal(readFileSync(oldArtifact, 'utf8'), 'previous user artifact');
    assert.equal(existsSync(buildMarker), false);
    assert.equal(existsSync(executionMarker), false, 'no app, Go host or registration script execution');
    assert.equal(existsSync(join(home, 'Library')), false, 'no browser registration or HOME installation');

    const appName = 'SSH Browser Helper.app';
    const app = join(output, appName);
    const contents = join(app, 'Contents');
    const resources = join(contents, 'Resources');
    const launcher = join(contents, 'MacOS/SSH Browser Helper');
    const nativeHost = join(contents, 'MacOS/ssh-browser-native-host');
    const plist = join(contents, 'Info.plist');
    checked('/usr/bin/plutil', ['-lint', plist]);
    assert.equal(checked('/usr/bin/plutil', ['-extract', 'CFBundleExecutable', 'raw', '-o', '-', plist]).stdout.trim(), 'SSH Browser Helper');
    assert.equal(checked('/usr/bin/plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', plist]).stdout.trim(), 'com.sshbrowser.helperapp');
    assert.deepEqual(readdirSync(join(contents, 'MacOS')).sort(), ['SSH Browser Helper', 'ssh-browser-native-host']);
    assert.deepEqual(readdirSync(resources).sort(), ['extension-id.txt', 'scripts']);
    assert.deepEqual(readdirSync(join(resources, 'scripts')), ['register-helper-macos.sh']);
    assert.equal(readFileSync(join(resources, 'extension-id.txt'), 'utf8'), expectedId);
    assert.deepEqual(readFileSync(join(resources, 'scripts/register-helper-macos.sh')), readFileSync(join(fixture, 'scripts/register-helper-macos.sh')));
    assert.equal(existsSync(join(resources, 'payload')), false);
    assert.equal(existsSync(join(resources, 'extension')), false);
    for (const binary of [launcher, nativeHost]) {
      for (const arch of ['arm64', 'x86_64']) checked('/usr/bin/lipo', [binary, '-verify_arch', arch]);
      checked('/usr/bin/codesign', ['--verify', '--strict', binary]);
      assert.ok(statSync(binary).mode & 0o111);
    }
    checked('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
    for (const target of [app, nativeHost]) {
      const details = checked('/usr/bin/codesign', ['-d', '--verbose=4', target]).stderr;
      assert.match(details, /Signature=adhoc/);
      assert.doesNotMatch(details, /Timestamp=(?!none)/);
    }

    const helperZip = join(output, 'SSH-Browser-Helper-macos-universal.zip');
    const extracted = join(sandbox, 'extracted helper zip');
    checked('/usr/bin/ditto', ['-x', '-k', helperZip, extracted]);
    assert.deepEqual(readdirSync(extracted), [appName]);
    const extractedApp = join(extracted, appName);
    checked('/usr/bin/codesign', ['--verify', '--deep', '--strict', extractedApp]);
    for (const binary of ['SSH Browser Helper', 'ssh-browser-native-host']) {
      for (const arch of ['arm64', 'x86_64']) checked('/usr/bin/lipo', [join(extractedApp, 'Contents/MacOS', binary), '-verify_arch', arch]);
    }
    const extensionZip = join(output, 'SSH-Browser-Extension.zip');
    const extractedExtension = join(sandbox, 'extracted extension zip');
    checked('/usr/bin/ditto', ['-x', '-k', extensionZip, extractedExtension]);
    assert.deepEqual(readdirSync(extractedExtension), ['extension']);
    for (const file of ['manifest.json', 'ID.txt', 'vendor/fixture.css']) {
      assert.deepEqual(readFileSync(join(extractedExtension, 'extension', file)), readFileSync(join(fixture, 'extension', file)));
    }
    const extractedKey = JSON.parse(readFileSync(join(extractedExtension, 'extension/manifest.json'), 'utf8')).key;
    assert.equal(extensionId(extractedKey), expectedId.trim());
    assert.equal(existsSync(join(extractedExtension, appName)), false);
    assert.equal(existsSync(join(extractedExtension, 'scripts')), false);
    // The extension packager works with no helper, Swift or registration inputs.
    const standaloneSource = join(sandbox, 'extension only source');
    cpSync(join(fixture, 'extension'), join(standaloneSource, 'extension'), { recursive: true });
    for (const file of ['manifest.json', 'ID.txt', 'vendor/fixture.css']) {
      chmodSync(join(standaloneSource, 'extension', file), 0o600);
      utimesSync(join(standaloneSource, 'extension', file), new Date('2001-01-01'), new Date('2001-01-01'));
    }
    const standaloneZip = join(sandbox, 'standalone extension.zip');
    checked(process.execPath, [extensionScript, '--source-root', standaloneSource, '--output', standaloneZip], options);
    assert.deepEqual(readFileSync(standaloneZip), readFileSync(extensionZip), 'ZIP bytes are independent of input mtimes, permissions and helper packaging');
    const duplicateExtension = run(process.execPath, [extensionScript, '--source-root', standaloneSource, '--output', standaloneZip], options);
    assert.notEqual(duplicateExtension.status, 0);
    assert.deepEqual(readFileSync(standaloneZip), readFileSync(extensionZip), 'standalone extension packaging must never replace an existing artifact');
    writeFileSync(join(standaloneSource, 'extension/ID.txt'), `${'a'.repeat(32)}\n`);
    const mismatchZip = join(sandbox, 'mismatched extension.zip');
    const mismatched = run(process.execPath, [extensionScript, '--source-root', standaloneSource, '--output', mismatchZip], options);
    assert.notEqual(mismatched.status, 0, 'a different ID must not be bundled with the manifest key');
    assert.equal(existsSync(mismatchZip), false);
    const dmg = join(output, 'SSH-Browser-Helper-macos-universal.dmg');
    if (existsSync(dmg)) checked('/usr/bin/hdiutil', ['imageinfo', dmg]);

    const before = [readFileSync(helperZip), readFileSync(extensionZip)];
    const repeated = run('/bin/bash', [packageScript, '--skip-helper', '--source-root', fixture, '--output', output], options);
    assert.notEqual(repeated.status, 0);
    assert.match(repeated.stderr, /already exists/);
    assert.deepEqual(readFileSync(helperZip), before[0]);
    assert.deepEqual(readFileSync(extensionZip), before[1]);

    const missing = join(fixture, 'bin/ssh-browser-helper-darwin-arm64');
    rmSync(missing);
    const absent = run('/bin/bash', [packageScript, '--source-root', fixture, '--output', join(sandbox, 'missing output')], options);
    assert.notEqual(absent.status, 0);
    assert.match(absent.stderr, /Missing prebuilt helper/);
    assert.match(absent.stderr, /GO_BIN=.*scripts\/build\.sh/);
    assert.equal(existsSync(join(sandbox, 'missing output')), false);
    const builtOutput = join(sandbox, 'explicit build output');
    const built = run('/bin/bash', [packageScript, '--build', '--source-root', fixture, '--output', builtOutput], options);
    assert.equal(built.error, undefined);
    assert.equal(built.status, 42);
    assert.equal(readFileSync(buildMarker, 'utf8'), `0\n${goSentinel}\n`);
    assert.equal(existsSync(builtOutput), false);
    assert.equal(existsSync(executionMarker), false);
    assert.equal(existsSync(join(home, 'Library')), false);
    copyFileSync(join(fixture, 'prebuilt/ssh-browser-helper-darwin-amd64'), missing);
    const wrong = run('/bin/bash', [packageScript, '--source-root', fixture, '--output', join(sandbox, 'wrong arch output')], options);
    assert.notEqual(wrong.status, 0);
    assert.match(wrong.stderr, /wrong architecture/);
    const conflict = run('/bin/bash', [packageScript, '--build', '--skip-helper'], options);
    assert.equal(conflict.status, 2);
    assert.match(conflict.stderr, /cannot be combined/);
    writeFileSync(join(extractedApp, 'Contents/Resources/extension-id.txt'), 'tampered');
    const tampered = run('/usr/bin/codesign', ['--verify', '--deep', '--strict', extractedApp]);
    assert.notEqual(tampered.status, 0, 'sealed app resources must detect tampering');
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});
