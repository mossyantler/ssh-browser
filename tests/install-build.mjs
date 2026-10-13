import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
test('default build honors GO_BIN and compiles without native test execution', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-browser-build-fixture-'));
  try {
    fs.mkdirSync(path.join(temp, 'scripts')); fs.mkdirSync(path.join(temp, 'helper')); fs.mkdirSync(path.join(temp, 'home')); fs.mkdirSync(path.join(temp, 'tools'));
    fs.copyFileSync(path.join(root, 'scripts/build.sh'), path.join(temp, 'scripts/build.sh'));
    const go = path.join(temp, 'tools/custom-go'), log = path.join(temp, 'go-calls');
    fs.writeFileSync(go, `#!/bin/bash\nprintf '%s\\n' "$*" >> "$BUILD_FIXTURE_LOG"\n`, {mode: 0o755});
    // Darwin signing requires a real Mach-O. This fixture only records compile invocations.
    fs.writeFileSync(path.join(temp, 'tools/uname'), '#!/bin/sh\necho Linux\n', {mode: 0o755});
    const env = {...process.env, HOME: path.join(temp, 'home'), GO_BIN: go, BUILD_FIXTURE_LOG: log, PATH: path.join(temp, 'tools') + path.delimiter + process.env.PATH};
    const result = spawnSync('/bin/bash', [path.join(temp, 'scripts/build.sh')], {env, encoding: 'utf8'});
    assert.equal(result.status, 0, result.stderr);
    const calls = fs.readFileSync(log, 'utf8').trim().split('\n');
    assert.ok(calls.includes('vet ./...'));
    assert.equal(calls.filter(c => c.startsWith('test -c ')).length, 1);
    assert.equal(calls.filter(c => c.startsWith('build ')).length, 2);
    assert.ok(!calls.includes('test ./...'), 'native tests require --run-tests');
    fs.rmSync(log);
    const invalid = spawnSync('/bin/bash', [path.join(temp, 'scripts/build.sh'), '--unknown'], {env, encoding: 'utf8'});
    assert.equal(invalid.status, 2); assert.ok(!fs.existsSync(log), 'invalid flags fail before invoking toolchain');
  } finally { fs.rmSync(temp, {recursive: true, force: true}); }
});
