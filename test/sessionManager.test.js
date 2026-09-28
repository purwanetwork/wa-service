import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MaxSessionsError, SessionManager } from '../src/sessionManager.js';
import { LOGGED_IN_CREDS, makeSession, silentLogger, tempDir, writeCreds } from './helpers.js';

function manager({ sessionsDir = tempDir(), maxSessions = 6, failing = [] } = {}) {
  const created = [];
  const instance = new SessionManager({
    sessionsDir,
    maxSessions,
    logger: silentLogger,
    createSession: (key) => {
      const context = makeSession({ key, sessionsDir });

      if (failing.includes(key)) {
        context.session.connect = async () => {
          throw new Error('rusak');
        };
      }

      created.push(context);

      return context.session;
    },
  });

  return { instance, created, sessionsDir };
}

test('MAX_SESSIONS: sesi ke-(maks+1) ditolak, sesi yang sudah ada tetap bisa diambil', () => {
  const { instance } = manager({ maxSessions: 2 });
  instance.getOrCreate('saaa');
  instance.getOrCreate('sbbb');

  assert.throws(() => instance.getOrCreate('sccc'), MaxSessionsError);
  assert.equal(instance.getOrCreate('saaa').key, 'saaa');
});

test('sesi yang sudah logout tidak menghitung batas', async () => {
  const { instance } = manager({ maxSessions: 1 });
  const first = instance.getOrCreate('saaa');
  await first.logout();

  assert.doesNotThrow(() => instance.getOrCreate('sbbb'));
});

test('muat otomatis hanya folder yang sudah login (me && account) dengan nama sah', async () => {
  const sessionsDir = tempDir();
  writeCreds(sessionsDir, 'saaa', LOGGED_IN_CREDS);
  writeCreds(sessionsDir, 'sbbb', { me: { id: '6281@s.whatsapp.net' } });
  writeCreds(sessionsDir, 'platform', LOGGED_IN_CREDS);
  writeCreds(sessionsDir, 'Bukan Kunci', LOGGED_IN_CREDS);
  const { instance } = manager({ sessionsDir });

  const started = await instance.loadExisting();

  assert.deepEqual(started, ['platform', 'saaa']);
  assert.equal(instance.get('sbbb'), null);
});

test('satu sesi gagal dimuat tidak menghentikan sesi lain', async () => {
  const sessionsDir = tempDir();
  writeCreds(sessionsDir, 'saaa', LOGGED_IN_CREDS);
  writeCreds(sessionsDir, 'sbbb', LOGGED_IN_CREDS);
  writeCreds(sessionsDir, 'sccc', LOGGED_IN_CREDS);
  const { instance } = manager({ sessionsDir, failing: ['sbbb'] });

  assert.deepEqual(await instance.loadExisting(), ['saaa', 'sccc']);
  assert.equal(instance.get('saaa').status, 'connecting');
  assert.equal(instance.get('sccc').status, 'connecting');
});

test('status sesi yang belum pernah ada = offline, tanpa membuat sesi', () => {
  const { instance } = manager();

  assert.equal(instance.status('sbelumada').status, 'offline');
  assert.equal(instance.get('sbelumada'), null);
});

test('ringkasan /health: status dan jumlah file, tanpa nomor/QR', () => {
  const sessionsDir = tempDir();
  writeCreds(sessionsDir, 'saaa', LOGGED_IN_CREDS);
  const { instance } = manager({ sessionsDir });
  instance.getOrCreate('saaa');

  assert.deepEqual(instance.summary(), [{ key: 'saaa', status: 'offline', files: 1 }]);
});
