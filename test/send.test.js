import assert from 'node:assert/strict';
import { test } from 'node:test';
import { IdempotencyStore } from '../src/idempotencyStore.js';
import { makeSession, onlineSession, tempDir, tick } from './helpers.js';

const TO = '6281200000099';

test('kirim: onWhatsApp dulu, JID dari hasilnya, ID pesan dibuat sebelum kirim, ack server ditunggu', async () => {
  const { session, sockets } = await onlineSession();
  const result = await session.send({ to: TO, message: 'Halo', ref: '41', idempotencyKey: 'm41a1' });

  assert.equal(result.httpStatus, 200);
  assert.equal(result.body.success, true);
  assert.equal(result.body.server_ack, true);
  assert.deepEqual(sockets[0].lookups, [TO]);
  assert.equal(sockets[0].sent.length, 1);
  assert.equal(sockets[0].sent[0].jid, `${TO}@s.whatsapp.net`);
  assert.equal(sockets[0].sent[0].options.messageId, result.body.message_id);
});

test('idempoten: kunci yang sudah selesai mengembalikan hasil lama tanpa kirim kedua', async () => {
  const { session, sockets } = await onlineSession();
  const first = await session.send({ to: TO, message: 'Halo', ref: '41', idempotencyKey: 'm41a1' });
  const second = await session.send({ to: TO, message: 'Halo', ref: '41', idempotencyKey: 'm41a1' });

  assert.deepEqual(second, first);
  assert.equal(sockets[0].sent.length, 1);
});

test('idempoten: kunci yang masih dikirim dijawab 409', async () => {
  const { session, timers } = await onlineSession({ socketOptions: { ackOnSend: false } });
  const first = session.send({ to: TO, message: 'Halo', ref: '41', idempotencyKey: 'm41a1' });
  await tick();
  const second = await session.send({ to: TO, message: 'Halo', ref: '41', idempotencyKey: 'm41a1' });
  timers.runAll();
  const firstResult = await first;

  assert.equal(second.httpStatus, 409);
  assert.equal(second.body.error_code, 'in_progress');
  assert.equal(firstResult.body.success, true);
  assert.equal(firstResult.body.server_ack, false);
});

test('idempoten: kiriman yang terhenti di proses sebelumnya = tidak pasti, tidak dikirim ulang', async () => {
  const stateDir = tempDir();
  const earlier = new IdempotencyStore({ stateDir, sessionKey: 's0123456789abcdef' });
  earlier.begin('m41a1', '41');
  earlier.attachMessageId('m41a1', '3EB0LAMA');

  const { session, sockets } = await onlineSession({ stateDir });
  const result = await session.send({ to: TO, message: 'Halo', ref: '41', idempotencyKey: 'm41a1' });

  assert.equal(result.body.error_code, 'uncertain');
  assert.equal(result.body.message_id, '3EB0LAMA');
  assert.equal(sockets[0].sent.length, 0);
});

test('nomor tidak terdaftar: 422 not_on_whatsapp tanpa sendMessage, dan diingat (tanpa tanya lagi)', async () => {
  const { session, sockets } = await onlineSession();
  const result = await session.send({ to: '6281299999999', message: 'Halo', ref: '7', idempotencyKey: 'm7a1' });
  await session.send({ to: '6281299999999', message: 'Halo', ref: '8', idempotencyKey: 'm8a1' });

  assert.equal(result.httpStatus, 422);
  assert.equal(result.body.error_code, 'not_on_whatsapp');
  assert.equal(sockets[0].sent.length, 0);
  assert.equal(sockets[0].lookups.length, 1);
});

test('tujuan berupa JID, grup, atau bukan digit ditolak 400', async () => {
  const { session, sockets } = await onlineSession();

  for (const to of [`${TO}@s.whatsapp.net`, '120363000000000000@g.us', '+6281200000099', '0812 000', '', null, '123']) {
    const result = await session.send({ to, message: 'Halo' });
    assert.equal(result.httpStatus, 400, String(to));
    assert.equal(result.body.error_code, 'invalid');
  }

  assert.equal(sockets[0].sent.length, 0);
  assert.equal(sockets[0].lookups.length, 0);
});

test('pesan kosong, ref atau kunci idempoten aneh ditolak 400', async () => {
  const { session } = await onlineSession();

  assert.equal((await session.send({ to: TO, message: '  ' })).httpStatus, 400);
  assert.equal((await session.send({ to: TO, message: 'x', ref: '../1' })).httpStatus, 400);
  assert.equal((await session.send({ to: TO, message: 'x', idempotencyKey: 'a b' })).httpStatus, 400);
});

test('belum tersambung: 503 not_connected', async () => {
  const { session } = makeSession();
  const result = await session.send({ to: TO, message: 'Halo' });

  assert.equal(result.httpStatus, 503);
  assert.equal(result.body.error_code, 'not_connected');
});

test('ack server tidak datang dalam batas waktu: terkirim dengan server_ack false', async () => {
  const { session, timers } = await onlineSession({ socketOptions: { ackOnSend: false } });
  const pending = session.send({ to: TO, message: 'Halo', ref: '5', idempotencyKey: 'm5a1' });
  await tick();
  timers.runAll();
  const result = await pending;

  assert.equal(result.body.success, true);
  assert.equal(result.body.server_ack, false);
});

test('onWhatsApp gagal: 503, kunci idempoten dilepas (boleh dicoba lagi)', async () => {
  const { session, sockets } = await onlineSession({ socketOptions: { onWhatsAppError: new Error('timeout') } });
  const first = await session.send({ to: TO, message: 'Halo', ref: '5', idempotencyKey: 'm5a1' });
  const second = await session.send({ to: TO, message: 'Halo', ref: '5', idempotencyKey: 'm5a1' });

  assert.equal(first.httpStatus, 503);
  assert.equal(second.httpStatus, 503);
  assert.equal(sockets[0].lookups.length, 2);
});

test('sendMessage melempar: hasil tidak pasti dan diingat (tidak dikirim lagi)', async () => {
  const { session, sockets } = await onlineSession({ socketOptions: { sendError: new Error('Connection Closed') } });
  const first = await session.send({ to: TO, message: 'Halo', ref: '5', idempotencyKey: 'm5a1' });
  const second = await session.send({ to: TO, message: 'Halo', ref: '5', idempotencyKey: 'm5a1' });

  assert.equal(first.body.error_code, 'uncertain');
  assert.deepEqual(second.body, first.body);
  assert.equal(sockets[0].lookups.length, 1);
});

test('teks pesan tersedia untuk getMessage (kirim ulang ke penerima) hanya 6 jam', async () => {
  let now = 1_000_000;
  const { session } = await onlineSession({ deps: { now: () => now } });
  const result = await session.send({ to: TO, message: 'Isi pesan', ref: '5', idempotencyKey: 'm5a1' });

  assert.deepEqual(session.getMessage({ id: result.body.message_id }), { conversation: 'Isi pesan' });
  now += 6 * 60 * 60 * 1000 + 1;
  assert.equal(session.getMessage({ id: result.body.message_id }), undefined);
});
