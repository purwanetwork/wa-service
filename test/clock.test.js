import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { CallbackSender } from '../src/callbackSender.js';
import { APP_TIME_ZONE, isoWithOffset } from '../src/clock.js';
import { onlineSession, silentLogger, tempDir } from './helpers.js';

/**
 * Jam yang dikirim ke aplikasi = ISO 8601 ber-offset +07:00 (Asia/Jakarta),
 * bukan UTC "Z" (B-1): aplikasi menyimpan jam dari string tanpa konversi
 * zona. Harus sama walau proses berjalan dengan TZ=UTC atau zona lain.
 */
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const NOON_WIB = Date.UTC(2026, 9, 2, 5, 0, 0, 123); // 2026-10-02 12:00:00.123 WIB
const WIB_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}\+07:00$/;

test('isoWithOffset: jam WIB dengan offset +07:00, milidetik ikut, instan tidak berubah', () => {
  assert.equal(APP_TIME_ZONE, 'Asia/Jakarta');
  assert.equal(isoWithOffset(NOON_WIB), '2026-10-02T12:00:00.123+07:00');
  assert.equal(isoWithOffset(new Date(NOON_WIB)), '2026-10-02T12:00:00.123+07:00');
  assert.equal(Date.parse(isoWithOffset(NOON_WIB)), NOON_WIB);
});

test('isoWithOffset: lewat tengah malam UTC berganti tanggal WIB dengan benar', () => {
  assert.equal(isoWithOffset(Date.UTC(2026, 8, 30, 17, 30, 0, 0)), '2026-10-01T00:30:00.000+07:00');
  assert.equal(isoWithOffset(Date.UTC(2026, 11, 31, 16, 59, 59, 999)), '2026-12-31T23:59:59.999+07:00');
  assert.equal(isoWithOffset(Date.UTC(2026, 11, 31, 17, 0, 0, 0)), '2027-01-01T00:00:00.000+07:00');
});

test('isoWithOffset: zona lain tetap memakai offsetnya sendiri (fungsi tidak memaku +07:00)', () => {
  assert.equal(isoWithOffset(NOON_WIB, 'UTC'), '2026-10-02T05:00:00.123+00:00');
  assert.equal(isoWithOffset(NOON_WIB, 'Asia/Makassar'), '2026-10-02T13:00:00.123+08:00');
  assert.throws(() => isoWithOffset(Number.NaN), RangeError);
});

test('event callback (status sesi dan ack) membawa at ber-offset +07:00 dengan jam WIB yang benar', async () => {
  const callback = new CallbackSender({
    url: 'https://127.0.0.1/internal/wa-service/events',
    secret: 'rahasia-callback-uji-0123456789abcdef',
    node: 'wa-uji',
    bootId: 'boot-1',
    stateDir: tempDir(),
    logger: silentLogger,
    transport: async () => ({ status: 500, headers: {}, body: '' }),
    now: () => NOON_WIB,
    setTimer: () => 0,
    clearTimer: () => {},
  });
  const { events, session } = await onlineSession({ deps: { emit: (event) => callback.enqueue(event), now: () => NOON_WIB } });
  callback.enqueue({ type: 'message.ack', session: 's0123456789abcdef', ref: '7', message_id: 'X', ack: 'read', error: null });

  assert.equal(events.length, 0, 'event dialihkan ke CallbackSender');
  assert.ok(callback.events.length >= 3, 'connecting, online, ack');

  for (const event of callback.events) {
    assert.match(event.at, WIB_ISO, `${event.type} ${event.status ?? event.ack}`);
    assert.equal(event.at, '2026-10-02T12:00:00.123+07:00');
  }

  assert.equal(session.snapshot().since, '2026-10-02T12:00:00.123+07:00', '/status since');

  await callback.flush();
  assert.match(callback.status().last_error_at, WIB_ISO, '/health callback.last_error_at');
  assert.equal(callback.status().last_ok_at, null);
  callback.stop();
});

test('/health callback.last_ok_at ber-offset +07:00 setelah callback sukses', async () => {
  const callback = new CallbackSender({
    url: 'https://127.0.0.1/internal/wa-service/events',
    secret: 'rahasia-callback-uji-0123456789abcdef',
    node: 'wa-uji',
    bootId: 'boot-1',
    stateDir: tempDir(),
    logger: silentLogger,
    transport: async () => ({ status: 200, headers: {}, body: '' }),
    now: () => NOON_WIB,
    setTimer: () => 0,
    clearTimer: () => {},
  });
  callback.enqueue({ type: 'session.status', session: 's0123456789abcdef', status: 'online' });
  await callback.flush();

  assert.equal(callback.status().last_ok_at, '2026-10-02T12:00:00.123+07:00');
  callback.stop();
});

test('hasil sama walau proses berjalan dengan TZ=UTC atau TZ zona lain (tidak bergantung TZ proses/systemd)', () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-uji-tz-'));
  const script = `
    import { CallbackSender } from './src/callbackSender.js';
    import { isoWithOffset } from './src/clock.js';
    const sender = new CallbackSender({ url: 'https://127.0.0.1/x', secret: 's'.repeat(40), node: 'n', bootId: 'b',
      stateDir: process.argv[1], logger: null, transport: async () => ({ status: 500 }), now: () => ${NOON_WIB},
      setTimer: () => 0, clearTimer: () => {} });
    sender.enqueue({ type: 'session.status', session: 'abc', status: 'online' });
    sender.stop();
    console.log(JSON.stringify({ tz: Intl.DateTimeFormat().resolvedOptions().timeZone, iso: isoWithOffset(${NOON_WIB}), at: sender.events[0].at }));
  `;

  try {
    for (const tz of ['UTC', 'America/New_York', 'Asia/Jakarta']) {
      const child = spawnSync(process.execPath, ['--input-type=module', '-e', script, stateDir], { cwd: ROOT, env: { ...process.env, TZ: tz }, encoding: 'utf8' });
      assert.equal(child.status, 0, child.stderr);
      const result = JSON.parse(child.stdout.trim());
      assert.equal(result.tz, tz, 'TZ proses benar-benar diganti');
      assert.equal(result.iso, '2026-10-02T12:00:00.123+07:00', `TZ=${tz}`);
      assert.equal(result.at, '2026-10-02T12:00:00.123+07:00', `TZ=${tz}`);
    }
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});
