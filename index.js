import 'dotenv/config';
import crypto from 'node:crypto';
import QRCode from 'qrcode';
import makeWASocket, { fetchLatestBaileysVersion, generateMessageIDV2, useMultiFileAuthState } from '@whiskeysockets/baileys';
import { CallbackSender } from './src/callbackSender.js';
import { loadConfig } from './src/config.js';
import { createLeaseClient, LEASE_TTL_SECONDS, leaseUrlFrom } from './src/lease.js';
import { baileysLogger, createLogger, wrapConsole } from './src/logger.js';
import { createApp } from './src/routes.js';
import { IdempotencyStore } from './src/idempotencyStore.js';
import { RecipientCache } from './src/recipientCache.js';
import { Session } from './src/session.js';
import { createSessionLock } from './src/sessionLock.js';
import { moveSessionDirAside, removeSessionDir, SessionManager } from './src/sessionManager.js';

/**
 * wa-service multi-sesi: perakitan saja (config, logger, callback, lease,
 * sesi, HTTP) dan shutdown rapi (SIGTERM: socket ditutup TANPA logout,
 * lease dilepas, spool disimpan).
 */
let config;

try {
  config = loadConfig(process.env, process.cwd());
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

const logger = createLogger({ logDir: config.logDir, level: config.logLevel });
const consoleGuard = wrapConsole(logger);
const bootId = crypto.randomUUID();
const startedAt = new Date().toISOString();

const callbackSender = new CallbackSender({
  url: config.callbackUrl,
  secret: config.callbackSecret,
  hostHeader: config.callbackHost,
  node: config.nodeName,
  bootId,
  stateDir: config.stateDir,
  logger,
});

const lease = createLeaseClient({
  mode: config.leaseMode,
  url: leaseUrlFrom(config.callbackUrl),
  secret: config.callbackSecret,
  hostHeader: config.callbackHost,
  node: config.nodeName,
  bootId,
});

// Versi protokol WA diambil sekali per proses (bukan setiap connect).
let versionPromise = null;
const waVersion = () => {
  versionPromise ??= fetchLatestBaileysVersion({ timeout: 10000 })
    .then((result) => result.version)
    .catch(() => undefined);

  return versionPromise;
};

const baileys = baileysLogger(logger);

const manager = new SessionManager({
  sessionsDir: config.sessionsDir,
  maxSessions: config.maxSessions,
  logger,
  createSession: (key, dir) => new Session({
    key,
    dir,
    deps: {
      logger,
      emit: (event) => callbackSender.enqueue(event),
      lease,
      leaseRenewMs: (LEASE_TTL_SECONDS / 3) * 1000,
      lock: createSessionLock({ dir, node: config.nodeName, bootId, leaseMode: config.leaseMode }),
      idempotency: new IdempotencyStore({ stateDir: config.stateDir, sessionKey: key }),
      recipients: new RecipientCache(),
      createAuthState: (sessionDir) => useMultiFileAuthState(sessionDir),
      createSocket: async ({ auth, getMessage }) => makeWASocket({
        version: await waVersion(),
        auth,
        logger: baileys,
        markOnlineOnConnect: false,
        syncFullHistory: false,
        shouldSyncHistoryMessage: () => false,
        getMessage,
      }),
      generateMessageId: (sock) => generateMessageIDV2(sock.user?.id),
      qrToDataUrl: (qr) => QRCode.toDataURL(qr),
      removeDir: () => removeSessionDir(config.sessionsDir, key),
      moveAside: () => moveSessionDirAside(config.sessionsDir, key),
    },
  }),
});

const app = createApp({ config, manager, callbackSender, bootId, startedAt, logger, consoleDropped: consoleGuard.dropped });

const server = app.listen(config.port, config.host, () => {
  logger.info({ host: config.host, port: config.port, lease_mode: config.leaseMode, node: config.nodeName }, 'wa-service listening');
});

manager.loadExisting()
  .then((started) => logger.info({ sessions: started.length }, 'sesi tersimpan dimuat'))
  .catch((error) => logger.error({ error: error.message }, 'gagal memuat sesi tersimpan'));

let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  logger.info({ signal }, 'berhenti: socket ditutup tanpa logout');
  server.close();
  await manager.stopAll();
  await callbackSender.flush().catch(() => {});
  callbackSender.stop();
  setTimeout(() => process.exit(0), 200).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
