import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { BACKOFF_SECONDS, CallbackSender } from '../src/callbackSender.js';
import { sign, verify } from '../src/signature.js';
import { manualTimers, silentLogger, tempDir, tick } from './helpers.js';

const vector = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'hmac-vector.json'), 'utf8'));

function sender({ stateDir = tempDir(), respond = () => ({ status: 200, headers: {}, body: '' }), now = () => 1_790_000_000_000, maxEvents = 10000 } = {}) {
  const timers = manualTimers();
  const requests = [];
  const callback = new CallbackSender({
    url: 'https://127.0.0.1/internal/wa-service/events',
    secret: vector.secret,
    hostHeader: 'app.example.test',
    node: 'wa-uji',
    bootId: 'boot-1',
    stateDir,
    logger: silentLogger,
    transport: async (url, body, headers, options) => {
      requests.push({ url, body, headers, options });

      return respond(requests.length);
    },
    now,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    maxEvents,
  });

  return { callback, timers, requests, stateDir };
}

test('HMAC sama persis dengan vektor uji bersama (dicek juga di tes PHP)', () => {
  assert.equal(sign(vector.secret, vector.body, vector.timestamp), vector.header);
  assert.equal(verify(vector.secret, vector.body, vector.header, vector.timestamp), true);
  assert.equal(verify(vector.secret, `${vector.body} `, vector.header, vector.timestamp), false);
  assert.equal(verify('rahasia-lain', vector.body, vector.header, vector.timestamp), false);
  assert.equal(verify(vector.secret, vector.body, vector.header, vector.timestamp + 301), false);
});

test('batch dikirim bertanda tangan dengan Host aplikasi; sukses menghapus dari spool', async () => {
  const { callback, timers, requests } = sender();
  callback.enqueue({ type: 'session.status', session: 'platform', status: 'online' });
  callback.enqueue({ type: 'message.ack', session: 'platform', ref: '1', message_id: 'X', ack: 'server' });
  timers.runAll();
  await tick();

  assert.equal(requests.length, 1);
  const payload = JSON.parse(requests[0].body);
  assert.equal(payload.node, 'wa-uji');
  assert.equal(payload.boot_id, 'boot-1');
  assert.equal(payload.events.length, 2);
  assert.equal(verify(vector.secret, requests[0].body, requests[0].headers['x-wa-signature'], 1_790_000_000), true);
  assert.equal(requests[0].options.hostHeader, 'app.example.test');
  assert.equal(callback.status().pending, 0);
});

test('seq selalu naik, juga setelah restart', () => {
  const stateDir = tempDir();
  let clock = 1_790_000_000_000;
  const first = sender({ stateDir, now: () => clock, respond: () => ({ status: 500 }) }).callback;
  first.enqueue({ type: 'a' });
  first.enqueue({ type: 'b' });
  clock -= 60_000;
  const second = sender({ stateDir, now: () => clock, respond: () => ({ status: 500 }) }).callback;
  second.enqueue({ type: 'c' });

  const seqs = second.events.map((event) => event.seq);
  assert.equal(seqs.length, 3);
  assert.ok(seqs[0] < seqs[1] && seqs[1] < seqs[2], seqs.join(','));
});

test('aplikasi mati: event tetap di spool, bertahan restart, jeda naik, lalu terkirim', async () => {
  const stateDir = tempDir();
  const { callback, timers, requests } = sender({ stateDir, respond: () => ({ status: 503 }) });
  callback.enqueue({ type: 'message.ack', ref: '1' });

  const delays = [];

  for (let i = 0; i < 3; i++) {
    timers.runAll();
    await tick();
    await tick();
    delays.push(timers.delays().at(-1));
  }

  assert.deepEqual(delays, BACKOFF_SECONDS.slice(0, 3).map((seconds) => seconds * 1000));
  assert.equal(requests.length, 3);
  assert.equal(fs.statSync(path.join(stateDir, 'spool.json')).mode & 0o777, 0o600);

  const restarted = sender({ stateDir });
  assert.equal(restarted.callback.status().pending, 1);
  restarted.callback.schedule(0);
  restarted.timers.runAll();
  await tick();

  assert.equal(restarted.requests.length, 1);
  assert.equal(restarted.callback.status().pending, 0);
  assert.equal(JSON.parse(fs.readFileSync(path.join(stateDir, 'spool.json'), 'utf8')).events.length, 0);
});

test('401/404 (secret salah, aplikasi lama) tidak pernah membuang event', async () => {
  for (const status of [401, 404, 422]) {
    const { callback, timers } = sender({ respond: () => ({ status }) });
    callback.enqueue({ type: 'x' });
    timers.runAll();
    await tick();

    assert.equal(callback.status().pending, 1, String(status));
  }
});

test('batas spool: yang tertua dibuang dan dihitung', () => {
  const { callback } = sender({ maxEvents: 3, respond: () => ({ status: 500 }) });

  for (const type of ['a', 'b', 'c', 'd', 'e']) {
    callback.enqueue({ type });
  }

  assert.deepEqual(callback.events.map((event) => event.type), ['c', 'd', 'e']);
  assert.equal(callback.status().dropped, 2);
});

test('lebih dari 100 event dikirim dalam beberapa batch', async () => {
  const { callback, timers, requests } = sender();

  for (let i = 0; i < 150; i++) {
    callback.events.push({ id: `e${i}`, seq: i, type: 'x' });
  }

  callback.schedule(0);

  for (let i = 0; i < 3; i++) {
    timers.runAll();
    await tick();
  }

  assert.deepEqual(requests.map((request) => JSON.parse(request.body).events.length), [100, 50]);
});
