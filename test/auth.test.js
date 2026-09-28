import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mock, test } from 'node:test';
import { bearerAuth, ipAllowlist, tokensMatch } from '../src/auth.js';
import { parseAddressList } from '../src/network.js';

const TOKEN = 'token-uji-yang-cukup-panjang-0123456789';

function run(middleware, headers = {}, remoteAddress = '127.0.0.1') {
  const result = { status: null, body: null, next: false };
  const res = {
    status(code) {
      result.status = code;

      return this;
    },
    json(body) {
      result.body = body;

      return this;
    },
  };
  middleware({ headers, socket: { remoteAddress } }, res, () => {
    result.next = true;
  });

  return result;
}

test('token benar diterima', () => {
  assert.equal(run(bearerAuth(TOKEN), { authorization: `Bearer ${TOKEN}` }).next, true);
});

test('token salah, beda panjang, tanpa skema, dan kosong ditolak 401', () => {
  for (const header of [`Bearer ${TOKEN}x`, `Bearer ${TOKEN.slice(0, -1)}`, 'Bearer a', TOKEN, `Basic ${TOKEN}`, 'Bearer', '', `Bearer  ${TOKEN}`]) {
    const result = run(bearerAuth(TOKEN), { authorization: header });
    assert.equal(result.next, false, header);
    assert.equal(result.status, 401, header);
  }

  assert.equal(run(bearerAuth(TOKEN), {}).status, 401);
});

test('perbandingan token lewat timingSafeEqual, juga untuk panjang berbeda', () => {
  const spy = mock.method(crypto, 'timingSafeEqual');

  try {
    assert.equal(tokensMatch('pendek', TOKEN), false);
    assert.equal(tokensMatch(TOKEN, TOKEN), true);
    assert.equal(spy.mock.callCount(), 2);
  } finally {
    spy.mock.restore();
  }
});

test('token kosong di sisi server tidak pernah cocok', () => {
  assert.equal(tokensMatch('', ''), false);
});

test('IP di luar WA_ALLOWED_IPS ditolak 403 sebelum token diperiksa', () => {
  const allow = ipAllowlist(parseAddressList('127.0.0.1,::1,10.250.0.0/30'));

  assert.equal(run(allow, {}, '127.0.0.1').next, true);
  assert.equal(run(allow, {}, '::ffff:127.0.0.1').next, true);
  assert.equal(run(allow, {}, '::1').next, true);
  assert.equal(run(allow, {}, '10.250.0.1').next, true);
  assert.equal(run(allow, {}, '10.250.0.9').status, 403);
  assert.equal(run(allow, {}, '203.0.113.5').status, 403);
  assert.equal(run(allow, {}, null).status, 403);
});
