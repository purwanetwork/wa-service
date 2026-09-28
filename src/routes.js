import express from 'express';
import { bearerAuth, ipAllowlist } from './auth.js';
import { SessionError } from './session.js';
import { MaxSessionsError } from './sessionManager.js';
import { isValidSessionKey } from './sessionKey.js';

/**
 * API wa-service. Semua rute: IP pemanggil diizinkan (WA_ALLOWED_IPS) lalu
 * Bearer WA_SERVICE_TOKEN.
 *
 * Rute per sesi: /sessions/:key/{status,connect,logout,send}. Rute lama
 * (/status, /connect, /logout, /send) dipetakan ke WA_LEGACY_SESSION_KEY,
 * supaya aplikasi versi lama tetap jalan dengan wa-service ini (urutan deploy
 * bebas, jalan mundur terpisah). Dihapus setelah aplikasi baru stabil.
 */
const LEGACY_STATUS = { online: 'online', qr_pending: 'qr_pending' };

export function createApp({ config, manager, callbackSender, bootId, startedAt, logger, consoleDropped = {} }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', false);
  app.use(ipAllowlist(config.allowedIps));
  app.use(bearerAuth(config.token));
  app.use(express.json({ limit: '64kb' }));

  const sessionKey = (req, res) => {
    const key = req.params.key;

    if (!isValidSessionKey(key)) {
      res.status(400).json({ success: false, error: 'Kunci sesi tidak sah.', error_code: 'invalid' });

      return null;
    }

    return key;
  };

  const handleError = (res, error) => {
    if (error instanceof SessionError) {
      return res.status(error.httpStatus).json({ success: false, error: error.message, error_code: error.code });
    }

    if (error instanceof MaxSessionsError) {
      return res.status(429).json({ success: false, error: error.message, error_code: 'max_sessions' });
    }

    logger.error({ error: error.message }, 'kesalahan tak terduga');

    return res.status(500).json({ success: false, error: 'Kesalahan internal wa-service.', error_code: 'internal' });
  };

  const status = (key) => manager.status(key);

  const connect = async (key, body) => manager.getOrCreate(key).connect({ method: body?.method ?? 'qr', phone: body?.phone ?? null });

  const logout = async (key) => {
    const session = manager.get(key);

    if (!session) {
      // Tidak ada sesi berjalan: folder (bila ada) tetap dihapus.
      const created = manager.getOrCreate(key);
      const result = await created.logout();
      manager.forget(key);

      return result;
    }

    const result = await session.logout();
    manager.forget(key);

    return result;
  };

  const send = async (key, body) => {
    const session = manager.get(key);

    if (!session) {
      return { httpStatus: 404, body: { success: false, message_id: null, server_ack: false, error: 'Sesi tidak dikenal atau belum tersambung.', error_code: 'unknown_session' } };
    }

    return session.send({
      to: body?.to,
      message: body?.message,
      ref: body?.ref ?? null,
      idempotencyKey: body?.idempotency_key ?? null,
    });
  };

  app.get('/health', (req, res) => {
    res.json({
      ok: true,
      node: config.nodeName,
      boot_id: bootId,
      started_at: startedAt,
      lease_mode: config.leaseMode,
      max_sessions: config.maxSessions,
      sessions: manager.summary(),
      callback: callbackSender.status(),
      console_dropped: consoleDropped,
    });
  });

  app.get('/sessions/:key/status', (req, res) => {
    const key = sessionKey(req, res);

    if (key !== null) {
      res.json(status(key));
    }
  });

  app.post('/sessions/:key/connect', async (req, res) => {
    const key = sessionKey(req, res);

    if (key === null) {
      return;
    }

    try {
      res.json(await connect(key, req.body));
    } catch (error) {
      handleError(res, error);
    }
  });

  app.post('/sessions/:key/logout', async (req, res) => {
    const key = sessionKey(req, res);

    if (key === null) {
      return;
    }

    try {
      res.json(await logout(key));
    } catch (error) {
      handleError(res, error);
    }
  });

  app.post('/sessions/:key/send', async (req, res) => {
    const key = sessionKey(req, res);

    if (key === null) {
      return;
    }

    try {
      const result = await send(key, req.body);
      res.status(result.httpStatus).json(result.body);
    } catch (error) {
      handleError(res, error);
    }
  });

  // --- Rute lama (satu sesi) -> WA_LEGACY_SESSION_KEY ---
  const legacy = (handler) => async (req, res) => {
    if (!config.legacySessionKey) {
      return res.status(404).json({ success: false, error: 'Rute lama dimatikan (WA_LEGACY_SESSION_KEY kosong).', error_code: 'unknown_session' });
    }

    try {
      await handler(config.legacySessionKey, req, res);
    } catch (error) {
      handleError(res, error);
    }
  };

  app.get('/status', legacy(async (key, req, res) => {
    const current = status(key);
    res.json({ status: LEGACY_STATUS[current.status] ?? 'offline', qr: current.qr, jid: current.jid, name: current.name });
  }));

  app.post('/connect', legacy(async (key, req, res) => {
    const current = await connect(key, { method: 'qr' });
    res.json({ message: 'Proses koneksi dimulai.', status: LEGACY_STATUS[current.status] ?? 'offline' });
  }));

  app.post('/logout', legacy(async (key, req, res) => {
    await logout(key);
    res.json({ message: 'Logout berhasil.' });
  }));

  app.post('/send', legacy(async (key, req, res) => {
    const result = await send(key, { to: req.body?.to, message: req.body?.message });
    res.status(result.httpStatus === 404 ? 503 : result.httpStatus).json({
      success: result.body.success,
      message_id: result.body.message_id,
      error: result.body.error,
    });
  }));

  app.use((req, res) => res.status(404).json({ success: false, error: 'Tidak ditemukan.', error_code: 'not_found' }));

  return app;
}
