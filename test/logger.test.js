import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Writable } from 'node:stream';
import { test } from 'node:test';
import { createLogger, scrubText, wrapConsole } from '../src/logger.js';
import { tempDir } from './helpers.js';

function capture() {
  const lines = [];
  const destination = new Writable({
    write(chunk, encoding, callback) {
      lines.push(chunk.toString());
      callback();
    },
  });

  return { lines, logger: createLogger({ destination, level: 'debug' }) };
}

const SESSION_ENTRY = { indexInfo: { remoteIdentityKey: 'x' }, currentRatchet: { rootKey: 'KUNCI-AKAR', ephemeralKeyPair: { privKey: 'KUNCI-PRIVAT' } }, chains: { a: { chainKey: 'KUNCI-RANTAI' } } };

test('baris libsignal "Closing session" dan sejenisnya dibuang, hanya dihitung', () => {
  const { lines, logger } = capture();
  const fakeConsole = {};
  const guard = wrapConsole(logger, fakeConsole);

  fakeConsole.info('Closing session:', SESSION_ENTRY);
  fakeConsole.info('Opening session:', SESSION_ENTRY);
  fakeConsole.warn('Session already closed', SESSION_ENTRY);
  fakeConsole.warn('Closing open session in favor of incoming prekey bundle');
  fakeConsole.warn('Decrypted message with closed session.');
  fakeConsole.info('Removing old closed session:', SESSION_ENTRY);

  assert.equal(lines.join(''), '');
  assert.equal(guard.dropped.closing_session, 1);
  assert.equal(guard.dropped.decrypted_with_closed_session, 1);
});

test('console lain diteruskan sebagai teks saja; objeknya tidak pernah ikut', () => {
  const { lines, logger } = capture();
  const fakeConsole = {};
  wrapConsole(logger, fakeConsole);

  fakeConsole.warn('Unhandled bucket type (for naming):', 'object', SESSION_ENTRY);
  fakeConsole.error('Failed to decrypt message with any known session...');

  const output = lines.join('');
  assert.match(output, /Unhandled bucket type/);
  assert.match(output, /Failed to decrypt/);
  assert.doesNotMatch(output, /KUNCI-(AKAR|PRIVAT|RANTAI)/);
});

test('redact: jid, remoteJid, participant, phone, key, attrs di level atas dan dalam', () => {
  const { lines, logger } = capture();
  logger.warn({ jid: '6281200000001@s.whatsapp.net', phone: '6281200000001', key: { remoteJid: 'x' }, node: { attrs: { from: 'y' } }, deep: { inner: { remoteJid: 'z' } } }, 'uji');
  const output = lines.join('');

  assert.doesNotMatch(output, /6281200000001/);
  assert.doesNotMatch(output, /"remoteJid":"[xz]"/);
  assert.match(output, /disamarkan/);
});

test('teks dan nilai string disaring dari JID, @lid, dan nomor', () => {
  const { lines, logger } = capture();
  logger.warn({ note: 'kirim ke 6281200000001@s.whatsapp.net dan 123456789012345@lid' }, 'nomor +6281299998888 gagal, perangkat 6281200000001:12@s.whatsapp.net');
  const output = lines.join('');

  assert.doesNotMatch(output, /6281200000001|123456789012345|6281299998888/);
  assert.equal(scrubText('abc 628123456789 xyz'), 'abc [nomor] xyz');
});

test('file log dibuat 0640 di LOG_DIR', () => {
  const dir = tempDir();
  const logger = createLogger({ logDir: path.join(dir, 'log'), level: 'info' });
  logger.info('uji');

  assert.equal(fs.statSync(path.join(dir, 'log', 'wa-service.log')).mode & 0o777, 0o640);
});

test('kode tidak lagi memakai qrcode-terminal (QR tidak pernah dicetak)', () => {
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
  const sources = [path.join(root, 'index.js'), ...fs.readdirSync(path.join(root, 'src')).map((file) => path.join(root, 'src', file))];

  for (const file of sources) {
    assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /qrcode-terminal|qrcodeTerminal/, file);
  }
});
