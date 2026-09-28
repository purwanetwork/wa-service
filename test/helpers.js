import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pino from 'pino';
import { IdempotencyStore } from '../src/idempotencyStore.js';
import { RecipientCache } from '../src/recipientCache.js';
import { Session } from '../src/session.js';
import { moveSessionDirAside, removeSessionDir } from '../src/sessionManager.js';
import { resolveSessionDir } from '../src/sessionKey.js';

/**
 * Pendukung tes: socket Baileys palsu (tanpa jaringan), timer manual, dan
 * Session dengan dependensi palsu di folder sementara.
 */
const createdDirs = [];

// Folder sementara tes dihapus saat proses tes selesai.
process.on('exit', () => {
  for (const dir of createdDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

export function tempDir(prefix = 'wa-uji-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  createdDirs.push(dir);

  return dir;
}

export const silentLogger = pino({ level: 'silent' });

export function writeCreds(sessionsDir, key, creds) {
  const dir = path.join(sessionsDir, key);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'creds.json'), JSON.stringify(creds));

  return dir;
}

export const LOGGED_IN_CREDS = { me: { id: '6281200000001:3@s.whatsapp.net', name: 'Uji' }, account: { details: 'x' } };

/**
 * Socket palsu: onWhatsApp mengenal nomor di $registered; sendMessage
 * mencatat kiriman dan (bila ackOnSend) memancarkan ack server.
 */
export function fakeSocket({ registered = ['6281200000099'], ackOnSend = true, sendError = null, onWhatsAppError = null, pairingError = null } = {}) {
  const sock = {
    ev: new EventEmitter(),
    ws: new EventEmitter(),
    user: { id: '6281200000001:7@s.whatsapp.net', name: 'Nomor Uji' },
    sent: [],
    lookups: [],
    pairingRequests: [],
    ended: 0,
    loggedOut: 0,
    async onWhatsApp(number) {
      sock.lookups.push(number);

      if (onWhatsAppError) {
        throw onWhatsAppError;
      }

      return registered.includes(number) ? [{ jid: `${number}@s.whatsapp.net`, exists: true }] : [];
    },
    async sendMessage(jid, content, options) {
      if (sendError) {
        throw sendError;
      }

      sock.sent.push({ jid, content, options });

      if (ackOnSend) {
        sock.ws.emit('CB:ack,class:message', { attrs: { id: options.messageId, class: 'message' } });
      }

      return { key: { id: options.messageId } };
    },
    async requestPairingCode(phone) {
      sock.pairingRequests.push(phone);

      if (pairingError) {
        throw pairingError;
      }

      return 'KODE1234';
    },
    async logout() {
      sock.loggedOut++;
      sock.ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 401 } } } });
    },
    end() {
      sock.ended++;
    },
    close(code) {
      sock.ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: code } } } });
    },
    open() {
      sock.ev.emit('connection.update', { connection: 'open' });
    },
    qr(value = 'qr-mentah') {
      sock.ev.emit('connection.update', { qr: value });
    },
  };

  return sock;
}

/** Timer manual: tidak ada yang berjalan sampai run()/runAll() dipanggil. */
export function manualTimers() {
  let nextId = 1;
  const pending = new Map();

  return {
    pending,
    setTimer(callback, delay) {
      const id = nextId++;
      pending.set(id, { callback, delay });

      return id;
    },
    clearTimer(id) {
      pending.delete(id);
    },
    delays() {
      return [...pending.values()].map((item) => item.delay);
    },
    runAll() {
      const items = [...pending.entries()];
      pending.clear();

      for (const [, item] of items) {
        item.callback();
      }
    },
  };
}

export const tick = () => new Promise((resolve) => setImmediate(resolve));

export function localLease() {
  return {
    mode: 'local',
    calls: [],
    async acquire(key) {
      this.calls.push(['acquire', key]);

      return { granted: true, reason: 'local', transient: false };
    },
    async renew(key) {
      this.calls.push(['renew', key]);

      return { granted: true, reason: 'local', transient: false };
    },
    async release(key) {
      this.calls.push(['release', key]);

      return { granted: true, reason: 'local', transient: false };
    },
  };
}

export function noopLock() {
  return { acquired: 0, released: 0, acquire() { this.acquired++; return { ok: true }; }, release() { this.released++; } };
}

/**
 * Session berdependensi palsu. Mengembalikan session, events (callback),
 * sockets (setiap socket yang dibuat), timers, dan folder.
 */
export function makeSession({ key = 's0123456789abcdef', socketOptions = {}, lease = localLease(), lock = noopLock(), sessionsDir = tempDir(), stateDir = tempDir(), deps = {} } = {}) {
  const events = [];
  const sockets = [];
  const timers = manualTimers();
  const dir = resolveSessionDir(sessionsDir, key);
  const session = new Session({
    key,
    dir,
    deps: {
      logger: silentLogger,
      emit: (event) => events.push(event),
      lease,
      leaseRenewMs: 40000,
      lock,
      idempotency: new IdempotencyStore({ stateDir, sessionKey: key }),
      recipients: new RecipientCache(),
      createAuthState: async () => ({ state: { creds: JSON.parse(fs.existsSync(path.join(dir, 'creds.json')) ? fs.readFileSync(path.join(dir, 'creds.json'), 'utf8') : '{}') }, saveCreds: () => {} }),
      createSocket: async () => {
        const sock = fakeSocket(socketOptions);
        sockets.push(sock);

        return sock;
      },
      generateMessageId: () => `3EB0${String(sockets.length)}${String(Math.random()).slice(2, 10).toUpperCase()}`,
      qrToDataUrl: async (qr) => `data:image/png;base64,${Buffer.from(qr).toString('base64')}`,
      removeDir: () => removeSessionDir(sessionsDir, key),
      moveAside: () => moveSessionDirAside(sessionsDir, key, 1),
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
      random: () => 0.5,
      ...deps,
    },
  });

  return { session, events, sockets, timers, dir, sessionsDir, stateDir, lease, lock };
}

/** Session online dengan satu socket palsu. */
export async function onlineSession(options = {}) {
  const context = makeSession(options);
  await context.session.connect();
  context.sockets.at(-1).open();
  await tick();

  return context;
}
