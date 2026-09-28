import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { loadConfig } from '../src/config.js';
import { createApp } from '../src/routes.js';
import { SessionManager } from '../src/sessionManager.js';
import { makeSession, silentLogger, tempDir, tick } from './helpers.js';

const TOKEN = 'token-uji-rute-0123456789';
const LEGACY = 's0123456789abcdef';
let server;
let base;
let manager;
const contexts = new Map();

before(async () => {
  const sessionsDir = tempDir();
  const config = loadConfig({
    WA_SERVICE_TOKEN: TOKEN,
    WA_CALLBACK_SECRET: 'rahasia-callback-uji-0123456789abcdef',
    WA_CALLBACK_URL: 'https://127.0.0.1/internal/wa-service/events',
    WA_LEGACY_SESSION_KEY: LEGACY,
  }, tempDir());
  manager = new SessionManager({
    sessionsDir,
    maxSessions: 3,
    logger: silentLogger,
    createSession: (key) => {
      const context = makeSession({ key, sessionsDir });
      contexts.set(key, context);

      return context.session;
    },
  });
  const app = createApp({ config, manager, callbackSender: { status: () => ({ pending: 0, dropped: 0 }) }, bootId: 'boot', startedAt: 'x', logger: silentLogger });
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

const call = (method, path, body, token = TOKEN) => fetch(`${base}${path}`, {
  method,
  headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
});

test('tanpa token yang benar: 401', async () => {
  assert.equal((await call('GET', '/health', undefined, 'salah')).status, 401);
});

test('kunci sesi tidak sah di URL: 400', async () => {
  assert.equal((await call('GET', '/sessions/..%2Fetc/status')).status, 400);
  assert.equal((await call('POST', '/sessions/ABC/send', { to: '6281200000099', message: 'x' })).status, 400);
});

test('kirim ke sesi yang tidak dikenal: 404 unknown_session', async () => {
  const response = await call('POST', '/sessions/sbelumada/send', { to: '6281200000099', message: 'x' });

  assert.equal(response.status, 404);
  assert.equal((await response.json()).error_code, 'unknown_session');
});

test('connect per sesi, status, dan kirim lewat /sessions/:key', async () => {
  const connected = await call('POST', '/sessions/saaa/connect', { method: 'qr' });
  assert.equal(connected.status, 200);
  contexts.get('saaa').sockets[0].open();
  await tick();

  assert.equal((await (await call('GET', '/sessions/saaa/status')).json()).status, 'online');
  const sent = await call('POST', '/sessions/saaa/send', { to: '6281200000099', message: 'Halo', ref: '1', idempotency_key: 'm1a1' });
  const body = await sent.json();

  assert.equal(sent.status, 200);
  assert.equal(body.success, true);
  assert.equal(body.server_ack, true);
});

test('rute lama dipetakan ke WA_LEGACY_SESSION_KEY', async () => {
  await call('POST', '/connect');
  contexts.get(LEGACY).sockets[0].open();
  await tick();

  const status = await (await call('GET', '/status')).json();
  assert.equal(status.status, 'online');
  assert.equal(status.jid, '6281200000001');

  const sent = await call('POST', '/send', { to: '6281200000099', message: 'Halo lama' });
  const body = await sent.json();
  assert.equal(sent.status, 200);
  assert.equal(body.success, true);
  assert.deepEqual(Object.keys(body).sort(), ['error', 'message_id', 'success']);
  assert.equal(contexts.get(LEGACY).sockets[0].sent.length, 1);
});

test('health: status dan jumlah file per sesi, tanpa nomor atau QR', async () => {
  const health = await (await call('GET', '/health')).json();

  assert.equal(health.ok, true);
  assert.ok(health.sessions.every((item) => Object.keys(item).sort().join() === 'files,key,status'));
  assert.doesNotMatch(JSON.stringify(health), /6281200000001/);
});

test('batas sesi: 429 max_sessions', async () => {
  await call('POST', '/sessions/sbbb/connect', {});
  const response = await call('POST', '/sessions/sccc/connect', {});

  assert.equal(response.status, 429);
  assert.equal((await response.json()).error_code, 'max_sessions');
});

test('pemanggil di luar WA_ALLOWED_IPS ditolak 403 walau token benar', async () => {
  const config = loadConfig({
    WA_SERVICE_TOKEN: TOKEN,
    WA_CALLBACK_SECRET: 'rahasia-callback-uji-0123456789abcdef',
    WA_CALLBACK_URL: 'https://127.0.0.1/internal/wa-service/events',
    WA_ALLOWED_IPS: '10.250.0.1',
  }, tempDir());
  const app = createApp({ config, manager, callbackSender: { status: () => ({}) }, bootId: 'boot', startedAt: 'x', logger: silentLogger });
  const other = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => other.once('listening', resolve));

  try {
    const response = await fetch(`http://127.0.0.1:${other.address().port}/health`, { headers: { authorization: `Bearer ${TOKEN}` } });
    assert.equal(response.status, 403);
  } finally {
    other.close();
  }
});
