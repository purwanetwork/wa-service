import assert from 'node:assert/strict';
import { test } from 'node:test';
import { onlineSession, tick } from './helpers.js';

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
