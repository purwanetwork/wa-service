import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { createLeaseClient, leaseUrlFrom } from '../src/lease.js';
import { createSessionLock } from '../src/sessionLock.js';
import { sign } from '../src/signature.js';
import { LOGGED_IN_CREDS, makeSession, noopLock, tempDir, tick, writeCreds } from './helpers.js';

/**
 * Pengaman sesi ganda: lease aplikasi (lintas mesin) dan kunci lokal
 * (mesin yang sama).
 */
const SECRET = 'rahasia-callback-uji-0123456789abcdef';
const NOW = 1_790_000_000_000;

function signedReply(payload, secret = SECRET) {
  const body = JSON.stringify(payload);

  return { status: 200, headers: { 'x-wa-signature': sign(secret, body, Math.floor(NOW / 1000)) }, body };
}

function client(reply, requests = []) {
  return createLeaseClient({
    mode: 'app',
    url: 'https://127.0.0.1/internal/wa-service/lease',
    secret: SECRET,
    node: 'wa-baru',
    bootId: 'boot-2',
    now: () => NOW,
    transport: async (url, body, headers) => {
      requests.push({ url, body: JSON.parse(body), headers });

      return reply(JSON.parse(body));
    },
  });
}

test('URL lease diturunkan dari URL callback', () => {
  assert.equal(leaseUrlFrom('https://127.0.0.1/internal/wa-service/events'), 'https://127.0.0.1/internal/wa-service/lease');
});

test('lease diberikan hanya dengan jawaban bertanda tangan untuk sesi dan node ini', async () => {
  const requests = [];
  const granted = await client((body) => signedReply({ session: body.session, node: body.node, granted: true, ttl: 120 }), requests).acquire('s0123456789abcdef');

  assert.equal(granted.granted, true);
  assert.deepEqual(requests[0].body, { action: 'acquire', session: 's0123456789abcdef', node: 'wa-baru', boot_id: 'boot-2' });
  assert.match(requests[0].headers['x-wa-signature'], /^t=\d+,v1=[0-9a-f]{64}$/);

  const unsigned = await client((body) => ({ status: 200, headers: {}, body: JSON.stringify({ session: body.session, node: body.node, granted: true }) })).acquire('s0123456789abcdef');
  const wrongSecret = await client((body) => signedReply({ session: body.session, node: body.node, granted: true }, 'rahasia-lain-0123456789abcdef0123')).acquire('s0123456789abcdef');
  const otherSession = await client((body) => signedReply({ session: 'platform', node: body.node, granted: true })).acquire('s0123456789abcdef');
  const oldApp = await client(() => ({ status: 404, headers: {}, body: '' })).acquire('s0123456789abcdef');
  const down = await client(() => {
    throw new Error('ECONNREFUSED');
  }).acquire('s0123456789abcdef');

  for (const result of [unsigned, wrongSecret, otherSession, oldApp, down]) {
    assert.equal(result.granted, false);
    assert.equal(result.transient, true);
  }
});

test('lease ditolak (dipegang node lain): socket TIDAK dibuat, status lease_denied, dicoba lagi nanti', async () => {
  const lease = { mode: 'app', async acquire() { return { granted: false, reason: 'dipegang wa-lama', transient: false }; }, async renew() { return { granted: true }; }, async release() { return {}; } };
  const { session, sockets, timers, events } = makeSession({ lease });
  await session.connect();

  assert.equal(sockets.length, 0);
  assert.equal(session.status, 'lease_denied');
  assert.equal(events.at(-1).status, 'lease_denied');
  assert.equal(timers.pending.size, 1);
});

test('lease dicabut saat berjalan: socket dilepas tanpa logout, folder utuh', async () => {
  let renewReply = { granted: true, transient: false };
  const lease = { mode: 'app', async acquire() { return { granted: true }; }, async renew() { return renewReply; }, async release() { return {}; } };
  const sessionsDir = tempDir();
  const own = writeCreds(sessionsDir, 's0123456789abcdef', LOGGED_IN_CREDS);
  const { session, sockets, timers } = makeSession({ lease, sessionsDir });
  await session.connect();
  sockets[0].open();
  await tick();

  timers.runAll();
  await tick();
  assert.equal(session.status, 'online');

  renewReply = { granted: false, reason: 'dipegang wa-baru', transient: false };
  timers.runAll();
  await tick();

  assert.equal(session.status, 'lease_denied');
  assert.equal(sockets[0].ended, 1);
  assert.equal(sockets[0].loggedOut, 0);
  assert.equal(fs.existsSync(path.join(own, 'creds.json')), true);
});

test('aplikasi tidak terjangkau saat perpanjang: sesi tetap berjalan', async () => {
  const lease = { mode: 'app', async acquire() { return { granted: true }; }, async renew() { return { granted: false, transient: true, reason: 'down' }; }, async release() { return {}; } };
  const { session, sockets, timers } = makeSession({ lease });
  await session.connect();
  sockets[0].open();
  await tick();
  timers.runAll();
  await tick();

  assert.equal(session.status, 'online');
  assert.equal(sockets[0].ended, 0);
});

test('kunci lokal: proses lain yang masih hidup di mesin ini menolak; proses mati diambil alih', () => {
  const dir = tempDir();
  const first = createSessionLock({ dir, node: 'n', bootId: 'b1', leaseMode: 'app', hostname: 'mesin-a', pid: 101, isAlive: () => true });
  const second = createSessionLock({ dir, node: 'n', bootId: 'b2', leaseMode: 'app', hostname: 'mesin-a', pid: 202, isAlive: () => true });
  const afterCrash = createSessionLock({ dir, node: 'n', bootId: 'b3', leaseMode: 'app', hostname: 'mesin-a', pid: 303, isAlive: () => false });

  assert.equal(first.acquire().ok, true);
  assert.equal(second.acquire().ok, false);
  assert.equal(afterCrash.acquire().ok, true);
  assert.equal(fs.statSync(path.join(dir, '.lock')).mode & 0o777, 0o600);
});

test('kunci dari mesin lain: mode local menolak, mode app menyerahkan ke lease', () => {
  const dir = tempDir();
  createSessionLock({ dir, node: 'lama', bootId: 'b1', leaseMode: 'app', hostname: 'mesin-lama', pid: 1, isAlive: () => true }).acquire();

  assert.equal(createSessionLock({ dir, node: 'baru', bootId: 'b2', leaseMode: 'local', hostname: 'mesin-baru', pid: 2, isAlive: () => true }).acquire().ok, false);
  assert.equal(createSessionLock({ dir, node: 'baru', bootId: 'b2', leaseMode: 'app', hostname: 'mesin-baru', pid: 2, isAlive: () => true }).acquire().ok, true);
});

test('kunci dilepas saat stop, jadi proses berikutnya di mesin sama bisa mengambil', () => {
  const dir = tempDir();
  const first = createSessionLock({ dir, node: 'n', bootId: 'b1', leaseMode: 'app', hostname: 'mesin-a', pid: 101, isAlive: () => true });
  first.acquire();
  first.release();

  assert.equal(fs.existsSync(path.join(dir, '.lock')), false);
  assert.equal(createSessionLock({ dir, node: 'n', bootId: 'b2', leaseMode: 'local', hostname: 'mesin-a', pid: 202, isAlive: () => true }).acquire().ok, true);
});

test('kunci lokal menolak: lease tidak diminta dan socket tidak dibuat', async () => {
  const lock = { ...noopLock(), acquire() { return { ok: false, reason: 'dipegang proses lain' }; } };
  const calls = [];
  const lease = { mode: 'app', async acquire(key) { calls.push(key); return { granted: true }; }, async renew() { return { granted: true }; }, async release() { return {}; } };
  const { session, sockets } = makeSession({ lock, lease });
  await session.connect();

  assert.equal(session.status, 'lease_denied');
  assert.equal(sockets.length, 0);
  assert.deepEqual(calls, []);
});
