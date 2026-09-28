import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { isValidSessionKey, resolveSessionDir } from '../src/sessionKey.js';

test('kunci sesi sah: huruf kecil, angka, _ dan -, 3-64 karakter', () => {
  for (const key of ['s0123456789abcdef', 'platform', 'abc', 'a_b-c', 'x'.repeat(64)]) {
    assert.equal(isValidSessionKey(key), true, key);
  }
});

test('kunci tidak sah dan upaya traversal ditolak', () => {
  for (const key of ['', 'ab', '../etc', '..', '.', 'a/b', '%2e%2e', 'A12', '-abc', '_abc', 'abc ', 'x'.repeat(65), 'abc\u0000', null, undefined, 42]) {
    assert.equal(isValidSessionKey(key), false, String(key));
  }
});

test('resolveSessionDir selalu tepat satu tingkat di dalam SESSIONS_DIR', () => {
  const root = '/srv/wa/sessions';

  assert.equal(resolveSessionDir(root, 's0123456789abcdef'), path.join(root, 's0123456789abcdef'));
  assert.equal(resolveSessionDir(`${root}/`, 'platform'), path.join(root, 'platform'));

  for (const key of ['../sessions2', '..', 'a/../../b', '/etc', '%2e%2e%2fetc']) {
    assert.throws(() => resolveSessionDir(root, key), /tidak sah|di luar/);
  }
});
