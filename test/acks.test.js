import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CallbackSender } from '../src/callbackSender.js';
import { onlineSession, silentLogger, tempDir, tick } from './helpers.js';

const TO = '6281200000099';

const ackEvents = (events) => events.filter((event) => event.type === 'message.ack');

test('ack server, sampai (3), dibaca (4), diputar (5) menjadi event dengan ref yang benar', async () => {
  const { session, sockets, events } = await onlineSession();
  const { body } = await session.send({ to: TO, message: 'Halo', ref: '41', idempotencyKey: 'm41a1' });
  const id = body.message_id;

  for (const status of [3, 4, 5]) {
    sockets[0].ev.emit('messages.update', [{ key: { id, fromMe: true, remoteJid: '123@lid' }, update: { status } }]);
  }

  await tick();
  const acks = ackEvents(events);

  assert.deepEqual(acks.map((event) => event.ack), ['server', 'delivered', 'read', 'read']);
  assert.ok(acks.every((event) => event.ref === '41' && event.message_id === id && event.session === 's0123456789abcdef'));
});

test('ack error dari server menjadi event error', async () => {
  const { session, sockets, events } = await onlineSession({ socketOptions: { ackOnSend: false } });
  const pending = session.send({ to: TO, message: 'Halo', ref: '9', idempotencyKey: 'm9a1' });
  await tick();
  const id = sockets[0].sent[0].options.messageId;
  sockets[0].ws.emit('CB:ack,class:message', { attrs: { id, class: 'message', error: '463' } });
  const result = await pending;

  assert.equal(result.body.server_ack, false);
  assert.deepEqual(ackEvents(events).map((event) => [event.ack, event.error, event.ref]), [['error', '463', '9']]);
});

test('ID tanpa ref (pesan dari HP pemilik, pesan masuk) tidak menghasilkan event', async () => {
  const { session, sockets, events } = await onlineSession();

  sockets[0].ws.emit('CB:ack,class:message', { attrs: { id: '3EB0DARIHP', class: 'message' } });
  sockets[0].ev.emit('messages.update', [{ key: { id: '3EB0DARIHP', fromMe: true }, update: { status: 4 } }]);
  sockets[0].ev.emit('messages.update', [{ key: { id: '3EB0MASUK', fromMe: false }, update: { status: 4 } }]);
  await session.send({ to: TO, message: 'x' });
  await tick();

  assert.deepEqual(ackEvents(events), []);
});

test('update tanpa status (mis. reaksi) diabaikan', async () => {
  const { session, sockets, events } = await onlineSession();
  const { body } = await session.send({ to: TO, message: 'Halo', ref: '41', idempotencyKey: 'm41a1' });
  sockets[0].ev.emit('messages.update', [{ key: { id: body.message_id, fromMe: true }, update: { reactions: [] } }]);
  await tick();

  assert.deepEqual(ackEvents(events).map((event) => event.ack), ['server']);
});

// B-3a: penolakan server dilaporkan SEKALI dengan kodenya, dalam urutan apa pun.
test('B-3a urutan seperti Baileys: messages.update status 0 (kode di stub) lalu CB:ack error -> tepat satu error 463', async () => {
  const { session, sockets, events } = await onlineSession({ socketOptions: { ackOnSend: false } });
  const pending = session.send({ to: TO, message: 'Halo', ref: '12', idempotencyKey: 'm12a1' });
  await tick();
  const id = sockets[0].sent[0].options.messageId;

  sockets[0].ev.emit('messages.update', [{ key: { id, fromMe: true, remoteJid: '123@lid' }, update: { status: 0, messageStubParameters: ['463'] } }]);
  sockets[0].ws.emit('CB:ack,class:message', { attrs: { id, class: 'message', error: '463' } });
  await pending;

  assert.deepEqual(ackEvents(events).map((event) => [event.ack, event.error, event.ref]), [['error', '463', '12']]);
});

test('B-3a urutan terbalik: CB:ack error lalu messages.update status 0 -> tetap satu error 463', async () => {
  const { session, sockets, events } = await onlineSession({ socketOptions: { ackOnSend: false } });
  const pending = session.send({ to: TO, message: 'Halo', ref: '13', idempotencyKey: 'm13a1' });
  await tick();
  const id = sockets[0].sent[0].options.messageId;

  sockets[0].ws.emit('CB:ack,class:message', { attrs: { id, class: 'message', error: '463' } });
  sockets[0].ev.emit('messages.update', [{ key: { id, fromMe: true }, update: { status: 0, messageStubParameters: ['463'] } }]);
  await pending;

  assert.deepEqual(ackEvents(events).map((event) => [event.ack, event.error]), [['error', '463']]);
});

test('B-3a status 0 tanpa kode di stub -> satu error "status error" (cadangan)', async () => {
  const { session, sockets, events } = await onlineSession();
  const { body } = await session.send({ to: TO, message: 'Halo', ref: '14', idempotencyKey: 'm14a1' });
  sockets[0].ev.emit('messages.update', [{ key: { id: body.message_id, fromMe: true }, update: { status: 0 } }]);
  sockets[0].ev.emit('messages.update', [{ key: { id: body.message_id, fromMe: true }, update: { status: 0 } }]);
  await tick();

  assert.deepEqual(ackEvents(events).map((event) => [event.ack, event.error]), [['server', null], ['error', 'status error']]);
});

// B-3b: jam laporan = jam receipt di server WhatsApp (messageTimestamp, detik), bukan jam diproses.
test('B-3b sampai/dibaca membawa at = jam receipt (+07:00); tanpa jam receipt at tidak dikirim', async () => {
  const { session, sockets, events } = await onlineSession();
  const { body } = await session.send({ to: TO, message: 'Halo', ref: '15', idempotencyKey: 'm15a1' });
  const id = body.message_id;
  const deliveredAt = Date.UTC(2026, 9, 2, 2, 10, 0) / 1000; // 09:10 WIB
  const readAt = Date.UTC(2026, 9, 2, 7, 5, 30) / 1000; // 14:05:30 WIB

  sockets[0].ev.emit('messages.update', [{ key: { id, fromMe: true }, update: { status: 3, messageTimestamp: deliveredAt } }]);
  sockets[0].ev.emit('messages.update', [{ key: { id, fromMe: true }, update: { status: 4, messageTimestamp: { toNumber: () => readAt } } }]);
  sockets[0].ev.emit('messages.update', [{ key: { id, fromMe: true }, update: { status: 5, messageTimestamp: 0 } }]);
  sockets[0].ev.emit('messages.update', [{ key: { id, fromMe: true }, update: { status: 5 } }]);
  await tick();

  const acks = ackEvents(events);
  assert.deepEqual(acks.map((event) => [event.ack, event.at]), [
    ['server', undefined],
    ['delivered', '2026-10-02T09:10:00.000+07:00'],
    ['read', '2026-10-02T14:05:30.000+07:00'],
    ['read', undefined],
    ['read', undefined],
  ]);
  assert.ok(acks.every((event) => !('at' in event) || typeof event.at === 'string'), 'tanpa at = kunci at tidak ada');
});

test('B-3b at dari receipt tidak ditimpa CallbackSender (jam spool hanya bawaan)', async () => {
  const callback = new CallbackSender({
    url: 'https://127.0.0.1/internal/wa-service/events', secret: 'rahasia-callback-uji-0123456789abcdef', node: 'wa-uji', bootId: 'b',
    stateDir: tempDir(), logger: silentLogger, transport: async () => ({ status: 500 }), now: () => Date.UTC(2026, 9, 2, 8, 0, 0),
    setTimer: () => 0, clearTimer: () => {},
  });
  const { session, sockets } = await onlineSession({ deps: { emit: (event) => callback.enqueue(event) } });
  const { body } = await session.send({ to: TO, message: 'Halo', ref: '16', idempotencyKey: 'm16a1' });
  sockets[0].ev.emit('messages.update', [{ key: { id: body.message_id, fromMe: true }, update: { status: 4, messageTimestamp: Date.UTC(2026, 9, 2, 7, 5, 30) / 1000 } }]);
  await tick();

  const read = callback.events.find((event) => event.ack === 'read');
  const server = callback.events.find((event) => event.ack === 'server');
  assert.equal(read.at, '2026-10-02T14:05:30.000+07:00', 'jam receipt');
  assert.equal(server.at, '2026-10-02T15:00:00.000+07:00', 'tanpa receipt: jam spool (sekarang)');
  callback.stop();
});
