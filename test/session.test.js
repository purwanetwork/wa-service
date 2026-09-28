import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { isLoggedIn, RECONNECT_BACKOFF_SECONDS } from '../src/session.js';
import { LOGGED_IN_CREDS, makeSession, onlineSession, tempDir, tick, writeCreds } from './helpers.js';

test('isLoggedIn: me DAN account; me saja (pairing kode belum selesai) = belum login', () => {
  assert.equal(isLoggedIn(LOGGED_IN_CREDS), true);
  assert.equal(isLoggedIn({ me: { id: '62812@s.whatsapp.net' } }), false);
  assert.equal(isLoggedIn({ account: {} }), false);
  assert.equal(isLoggedIn(null), false);
  assert.equal(isLoggedIn({}), false);
});

test('online: status, nomor tanpa perangkat, event status tanpa QR', async () => {
  const { session, events } = await onlineSession();

  assert.equal(session.status, 'online');
  assert.equal(session.jid, '6281200000001');
  assert.equal(session.name, 'Nomor Uji');
  const last = events.at(-1);
  assert.equal(last.type, 'session.status');
  assert.equal(last.status, 'online');
  assert.equal(last.jid, '6281200000001');
});

test('QR tampil di status tetapi TIDAK PERNAH ikut event callback', async () => {
  const { session, events, sockets } = makeSession();
  await session.connect();
  sockets[0].qr('qr-rahasia');
  await tick();

  assert.equal(session.snapshot().status, 'qr_pending');
  assert.match(session.snapshot().qr, /^data:image\/png;base64,/);
  assert.equal(events.some((event) => 'qr' in event || 'pairing_code' in event), false);
  assert.equal(JSON.stringify(events).includes('data:image'), false);
  assert.equal(JSON.stringify(events).includes(Buffer.from('qr-rahasia').toString('base64')), false);
});

test('putus biasa: sambung ulang berjeda naik (2 s -> 5 s -> 15 s ...)', async () => {
  const { session, sockets, timers } = await onlineSession();
  const delays = [];

  for (let i = 0; i < 4; i++) {
    sockets.at(-1).close(428);
    await tick();
    delays.push(timers.delays().at(-1));
    timers.runAll();
    await tick();
  }

  assert.deepEqual(delays, RECONNECT_BACKOFF_SECONDS.slice(0, 4).map((seconds) => seconds * 1000));
  assert.equal(sockets.length, 5);
  assert.equal(session.status, 'connecting');
});

test('403 diblokir: status blocked, TIDAK disambung ulang, event dikirim', async () => {
  const { session, sockets, timers, events } = await onlineSession();
  sockets[0].close(403);
  await tick();
  timers.runAll();
  await tick();

  assert.equal(session.status, 'blocked');
  assert.equal(sockets.length, 1);
  assert.equal(events.at(-1).status, 'blocked');
});

test('440 dipakai di tempat lain: status replaced, tidak disambung ulang', async () => {
  const { session, sockets, timers } = await onlineSession();
  sockets[0].close(440);
  await tick();
  timers.runAll();
  await tick();

  assert.equal(session.status, 'replaced');
  assert.equal(sockets.length, 1);
});

test('515 restart diminta: langsung disambung tanpa jeda', async () => {
  const { sockets } = await onlineSession();
  sockets[0].close(515);
  await tick();

  assert.equal(sockets.length, 2);
});

test('logout menghapus HANYA folder sesi itu', async () => {
  const sessionsDir = tempDir();
  const other = writeCreds(sessionsDir, 'platform', LOGGED_IN_CREDS);
  const own = writeCreds(sessionsDir, 's0123456789abcdef', LOGGED_IN_CREDS);
  const { session, sockets, events } = await onlineSession({ sessionsDir });

  await session.logout();

  assert.equal(sockets[0].loggedOut, 1);
  assert.equal(fs.existsSync(own), false);
  assert.equal(fs.existsSync(path.join(other, 'creds.json')), true);
  assert.equal(fs.existsSync(sessionsDir), true);
  assert.equal(session.status, 'logged_out');
  assert.equal(events.at(-1).status, 'logged_out');
});

test('logout dari HP (401): folder sesi dihapus, sesi lain utuh', async () => {
  const sessionsDir = tempDir();
  const other = writeCreds(sessionsDir, 'sffffffffffffffff', LOGGED_IN_CREDS);
  const own = writeCreds(sessionsDir, 's0123456789abcdef', LOGGED_IN_CREDS);
  const { session, sockets } = await onlineSession({ sessionsDir });
  sockets[0].close(401);
  await tick();

  assert.equal(session.status, 'logged_out');
  assert.equal(fs.existsSync(own), false);
  assert.equal(fs.existsSync(other), true);
});

test('kode pairing diminta sekali saat QR pertama, QR berikutnya diabaikan', async () => {
  const { session, sockets, events } = makeSession();
  await session.connect({ method: 'code', phone: '6281200000123' });
  sockets[0].qr('qr-1');
  await tick();
  sockets[0].qr('qr-2');
  await tick();

  assert.deepEqual(sockets[0].pairingRequests, ['6281200000123']);
  assert.equal(session.snapshot().status, 'pairing_code');
  assert.equal(session.snapshot().pairing_code, 'KODE1234');
  assert.equal(session.snapshot().qr, null);
  assert.equal(JSON.stringify(events).includes('KODE1234'), false);
});

test('metode kode tanpa nomor sah ditolak', async () => {
  const { session } = makeSession();

  await assert.rejects(session.connect({ method: 'code', phone: '0812-abc' }), /8-15 digit/);
  await assert.rejects(session.connect({ method: 'sms' }), /qr atau code/);
});

test('sesi setengah dipasangkan disisihkan sebelum pairing baru; sesi login tidak disentuh', async () => {
  const sessionsDir = tempDir();
  const half = writeCreds(sessionsDir, 's0123456789abcdef', { me: { id: '6281@s.whatsapp.net' } });
  const { session } = makeSession({ sessionsDir });
  await session.connect();

  assert.equal(fs.existsSync(path.join(half, 'creds.json')), false);
  assert.equal(fs.readdirSync(path.join(sessionsDir, '.stale')).length, 1);

  const loggedInDir = tempDir();
  const own = writeCreds(loggedInDir, 's0123456789abcdef', LOGGED_IN_CREDS);
  const second = makeSession({ sessionsDir: loggedInDir });
  await second.session.connect();

  assert.equal(fs.existsSync(path.join(own, 'creds.json')), true);
  assert.equal(fs.existsSync(path.join(loggedInDir, '.stale')), false);
});

test('QR kedaluwarsa (408) sebelum login: berhenti, tidak berputar', async () => {
  const { session, sockets, timers } = makeSession();
  await session.connect();
  sockets[0].qr();
  await tick();
  sockets[0].close(408);
  await tick();
  timers.runAll();
  await tick();

  assert.equal(session.status, 'offline');
  assert.equal(sockets.length, 1);
});

test('stop (shutdown): socket ditutup tanpa logout, folder utuh, lease dilepas', async () => {
  const sessionsDir = tempDir();
  const own = writeCreds(sessionsDir, 's0123456789abcdef', LOGGED_IN_CREDS);
  const { session, sockets, lease } = await onlineSession({ sessionsDir });
  await session.stop();

  assert.equal(sockets[0].ended, 1);
  assert.equal(sockets[0].loggedOut, 0);
  assert.equal(fs.existsSync(path.join(own, 'creds.json')), true);
  assert.deepEqual(lease.calls.at(-1), ['release', 's0123456789abcdef']);
});
