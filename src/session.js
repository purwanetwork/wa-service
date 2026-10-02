import fs from 'node:fs';
import path from 'node:path';
import { isoWithOffset } from './clock.js';

/**
 * Satu sesi = satu nomor WhatsApp tertaut = satu socket Baileys, dengan
 * status, penyambungan ulang berjeda, dan pengiriman sendiri. Error satu
 * sesi tidak pernah keluar dari objek ini (SessionManager menjaga).
 *
 * Socket, auth state, lease, kunci lokal, dan waktu disuntikkan (deps),
 * jadi tes memakai socket palsu tanpa jaringan.
 */
export const STATUSES = ['offline', 'connecting', 'qr_pending', 'pairing_code', 'online', 'logged_out', 'blocked', 'replaced', 'lease_denied'];

/** Jeda sambung ulang (detik) setelah koneksi putus, sebelum jitter. */
export const RECONNECT_BACKOFF_SECONDS = [2, 5, 15, 60, 300];

export const SERVER_ACK_WAIT_MS = 3000;

/** Teks pesan disimpan di memori untuk permintaan kirim ulang penerima (getMessage). */
export const MESSAGE_TEXT_TTL_MS = 6 * 60 * 60 * 1000;

export const LEASE_RETRY_MS = 120 * 1000;

export const DISCONNECT = Object.freeze({
  loggedOut: 401,
  forbidden: 403,
  timedOut: 408,
  connectionReplaced: 440,
  restartRequired: 515,
});

const RECEIPT_STATUS = { 0: 'error', 3: 'delivered', 4: 'read', 5: 'read' };

/**
 * Penanda sesi yang benar-benar sudah dipasangkan: `me` DAN `account`.
 * requestPairingCode mengisi `me` sebelum pairing selesai; `account` baru
 * diisi setelah pairing sukses (QR maupun kode).
 */
export function isLoggedIn(creds) {
  return Boolean(creds?.me && creds?.account);
}

export function jidNumber(jid) {
  const match = /^(\d+)/.exec(String(jid ?? ''));

  return match ? match[1] : null;
}

export class SessionError extends Error {
  constructor(message, httpStatus, code) {
    super(message);
    this.httpStatus = httpStatus;
    this.code = code;
  }
}

export class Session {
  /**
   * @param {object} options
   * @param {string} options.key
   * @param {string} options.dir folder sesi (sudah divalidasi resolveSessionDir)
   * @param {object} options.deps
   */
  constructor({ key, dir, deps }) {
    this.key = key;
    this.dir = dir;
    this.deps = {
      now: () => Date.now(),
      setTimer: setTimeout,
      clearTimer: clearTimeout,
      random: Math.random,
      ...deps,
    };
    this.logger = deps.logger.child({ session: key });
    this.status = 'offline';
    this.qr = null;
    this.pairingCode = null;
    this.jid = null;
    this.name = null;
    this.reason = null;
    this.since = this.deps.now();
    this.sock = null;
    this.pairing = null;
    this.manualStop = true;
    this.loggingOut = false;
    this.backoffIndex = 0;
    this.reconnectTimer = null;
    this.leaseTimer = null;
    this.leaseRetryTimer = null;
    this.texts = new Map();
    this.ackWaiters = new Map();
    this.recentAcks = new Map();
  }

  snapshot() {
    return {
      status: this.status,
      qr: this.status === 'qr_pending' ? this.qr : null,
      pairing_code: this.status === 'pairing_code' ? this.pairingCode : null,
      jid: this.jid,
      name: this.name,
      reason: this.reason,
      since: isoWithOffset(this.since),
    };
  }

  readCreds() {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.dir, 'creds.json'), 'utf8'));
    } catch {
      return null;
    }
  }

  hasSavedLogin() {
    return isLoggedIn(this.readCreds());
  }

  /**
   * extra.silent: status hanya lokal (/status, /health, log), TIDAK dikirim
   * sebagai callback. Dipakai untuk penolakan kunci lokal: proses kedua di
   * mesin yang sama hampir pasti ber-NODE_NAME sama dengan pemegang, jadi
   * aplikasi tidak bisa membedakan statusnya dari status pemegang.
   */
  setStatus(status, extra = {}) {
    const changed = status !== this.status || (extra.jid !== undefined && extra.jid !== this.jid);
    this.status = status;
    this.reason = extra.reason ?? null;
    this.qr = extra.qr ?? null;
    this.pairingCode = extra.pairingCode ?? null;

    if (extra.jid !== undefined) {
      this.jid = extra.jid;
    }

    if (extra.name !== undefined) {
      this.name = extra.name;
    }

    if (changed) {
      this.since = this.deps.now();
      this.logger.info({ status, reason: this.reason, callback: !extra.silent }, 'status sesi');

      if (extra.silent) {
        return;
      }

      // QR dan kode pairing TIDAK pernah ikut callback (diambil langsung lewat /status).
      this.deps.emit({ type: 'session.status', session: this.key, status, jid: this.jid, name: this.name, reason: this.reason });
    }
  }

  /**
   * Mulai (atau lanjutkan) koneksi. method "code" meminta kode pairing untuk
   * $phone (digit) saat QR pertama muncul, bukan QR.
   */
  async connect({ method = 'qr', phone = null } = {}) {
    if (method !== 'qr' && method !== 'code') {
      throw new SessionError('metode harus qr atau code', 400, 'invalid');
    }

    if (method === 'code' && !/^\d{8,15}$/.test(String(phone ?? ''))) {
      throw new SessionError('nomor untuk kode pairing harus 8-15 digit', 400, 'invalid');
    }

    if (this.sock && ['online', 'connecting', 'qr_pending', 'pairing_code'].includes(this.status)) {
      return this.snapshot();
    }

    this.pairing = method === 'code' ? { phone: String(phone), requested: false } : null;
    this.manualStop = false;
    this.backoffIndex = 0;
    await this.open();

    return this.snapshot();
  }

  async open() {
    this.clearTimer('reconnectTimer');

    if (this.manualStop) {
      return;
    }

    const lock = this.deps.lock.acquire();

    // Sesi dipegang proses lain di mesin ini: status tidak dikirim ke aplikasi
    // (lease_denied dari aplikasi di bawah tetap dikirim, disaring per node).
    if (!lock.ok) {
      this.setStatus('lease_denied', { reason: lock.reason, silent: true });

      return;
    }

    const lease = await this.deps.lease.acquire(this.key);

    if (!lease.granted) {
      this.setStatus('lease_denied', { reason: lease.reason });
      this.deps.lock.release();
      this.scheduleLeaseRetry();

      return;
    }

    this.startLeaseRenewal();

    const creds = this.readCreds();

    // Sesi setengah dipasangkan (kode pairing tidak diselesaikan): disisihkan,
    // bukan dihapus, lalu pairing mulai dari awal. Sesi yang sudah login
    // TIDAK PERNAH disentuh di sini.
    if (creds && !isLoggedIn(creds)) {
      this.deps.moveAside(this.dir);
    }

    this.setStatus('connecting');

    const { state, saveCreds } = await this.deps.createAuthState(this.dir);
    this.authState = state;
    const sock = await this.deps.createSocket({ auth: state, getMessage: async (key) => this.getMessage(key) });
    this.sock = sock;

    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', (update) => {
      this.onConnectionUpdate(update, sock).catch((error) => this.logger.error({ error: error.message }, 'gagal memproses connection.update'));
    });
    sock.ev.on('messages.update', (updates) => this.onMessagesUpdate(updates));
    sock.ws.on('CB:ack,class:message', (node) => this.onServerAck(node));
  }

  async onConnectionUpdate({ connection, lastDisconnect, qr }, sock) {
    if (sock !== this.sock) {
      return;
    }

    if (qr) {
      if (this.pairing) {
        if (!this.pairing.requested) {
          this.pairing.requested = true;

          try {
            const code = await sock.requestPairingCode(this.pairing.phone);
            this.setStatus('pairing_code', { pairingCode: code });
          } catch (error) {
            this.logger.warn({ error: error.message }, 'gagal meminta kode pairing');
            this.manualStop = true;
            this.pairing = null;
            this.sock = null;
            sock.end(undefined);
            this.setStatus('offline', { reason: 'Gagal meminta kode pairing; periksa nomor lalu coba lagi.' });
          }
        }
      } else {
        this.setStatus('qr_pending', { qr: await this.deps.qrToDataUrl(qr) });
      }
    }

    if (connection === 'open') {
      this.backoffIndex = 0;
      this.pairing = null;
      const user = sock.user ?? {};
      this.setStatus('online', {
        jid: jidNumber(user.id ?? this.authState?.creds?.me?.id),
        name: user.name ?? user.notify ?? user.verifiedName ?? this.authState?.creds?.me?.name ?? null,
      });
    }

    if (connection === 'close') {
      this.onClose(lastDisconnect?.error?.output?.statusCode);
    }
  }

  onClose(code) {
    this.sock = null;
    this.failAckWaiters();

    if (this.loggingOut || code === DISCONNECT.loggedOut) {
      this.loggingOut = false;
      this.manualStop = true;
      this.deps.removeDir(this.dir);
      this.stopLease(true);
      this.setStatus('logged_out', { jid: null, name: null });

      return;
    }

    if (code === DISCONNECT.forbidden) {
      this.manualStop = true;
      this.setStatus('blocked', { reason: 'WhatsApp menolak nomor ini (403); tidak disambung ulang otomatis.' });

      return;
    }

    if (code === DISCONNECT.connectionReplaced) {
      this.manualStop = true;
      this.setStatus('replaced', { reason: 'Sesi dipakai di tempat lain (440); tidak disambung ulang otomatis.' });

      return;
    }

    if (this.manualStop) {
      this.setStatus('offline');

      return;
    }

    if (code === DISCONNECT.timedOut && !isLoggedIn(this.authState?.creds)) {
      this.manualStop = true;
      this.pairing = null;
      this.setStatus('offline', { reason: 'QR/kode pairing kedaluwarsa; tekan Hubungkan lagi.' });

      return;
    }

    if (code === DISCONNECT.restartRequired) {
      this.setStatus('connecting', { reason: 'restart diminta WhatsApp' });
      this.open().catch((error) => this.onOpenError(error));

      return;
    }

    this.scheduleReconnect(code);
  }

  scheduleReconnect(code) {
    const base = RECONNECT_BACKOFF_SECONDS[Math.min(this.backoffIndex, RECONNECT_BACKOFF_SECONDS.length - 1)];
    const delayMs = Math.round(base * 1000 * (0.8 + this.deps.random() * 0.4));
    this.backoffIndex++;
    this.setStatus('offline', { reason: `terputus (kode ${code ?? '-'}); sambung ulang dalam ${Math.round(delayMs / 1000)} detik` });
    this.reconnectTimer = this.deps.setTimer(() => {
      this.reconnectTimer = null;
      this.open().catch((error) => this.onOpenError(error));
    }, delayMs);
  }

  onOpenError(error) {
    this.logger.error({ error: error.message }, 'gagal membuka sesi');
    this.sock = null;

    if (!this.manualStop) {
      this.scheduleReconnect(null);
    }
  }

  startLeaseRenewal() {
    if (this.deps.lease.mode === 'local' || this.leaseTimer !== null) {
      return;
    }

    const renew = async () => {
      this.leaseTimer = null;
      const result = await this.deps.lease.renew(this.key);

      if (!result.granted && !result.transient) {
        this.logger.warn({ reason: result.reason }, 'lease sesi dicabut; socket dilepas tanpa logout');
        this.manualStop = true;
        this.sock?.end(undefined);
        this.sock = null;
        this.deps.lock.release();
        this.setStatus('lease_denied', { reason: result.reason });
        this.scheduleLeaseRetry();

        return;
      }

      this.leaseTimer = this.deps.setTimer(() => renew().catch(() => {}), this.deps.leaseRenewMs);
    };

    this.leaseTimer = this.deps.setTimer(() => renew().catch(() => {}), this.deps.leaseRenewMs);
  }

  scheduleLeaseRetry() {
    this.clearTimer('leaseRetryTimer');
    this.leaseRetryTimer = this.deps.setTimer(() => {
      this.leaseRetryTimer = null;

      if (this.status === 'lease_denied') {
        this.manualStop = false;
        this.open().catch((error) => this.onOpenError(error));
      }
    }, LEASE_RETRY_MS);
  }

  stopLease(release) {
    this.clearTimer('leaseTimer');
    this.clearTimer('leaseRetryTimer');
    this.deps.lock.release();

    return release ? this.deps.lease.release(this.key).catch(() => {}) : Promise.resolve();
  }

  clearTimer(name) {
    if (this[name] !== null) {
      this.deps.clearTimer(this[name]);
      this[name] = null;
    }
  }

  /**
   * Kirim satu pesan teks.
   *
   * @returns {Promise<{httpStatus: number, body: object}>}
   */
  async send({ to, message, ref = null, idempotencyKey = null }) {
    if (!/^\d{8,15}$/.test(String(to ?? ''))) {
      return this.reply(400, { error: "Field 'to' wajib berupa nomor (8-15 digit), tanpa JID/grup.", error_code: 'invalid' });
    }

    if (typeof message !== 'string' || message.trim() === '' || message.length > 20000) {
      return this.reply(400, { error: "Field 'message' wajib diisi (maks. 20.000 karakter).", error_code: 'invalid' });
    }

    if (idempotencyKey !== null && !/^[\w:.-]{1,100}$/.test(String(idempotencyKey))) {
      return this.reply(400, { error: 'idempotency_key tidak sah.', error_code: 'invalid' });
    }

    if (ref !== null && !/^[\w:.-]{1,64}$/.test(String(ref))) {
      return this.reply(400, { error: 'ref tidak sah.', error_code: 'invalid' });
    }

    if (!this.sock || this.status !== 'online') {
      return this.reply(503, { error: 'Nomor WhatsApp belum tersambung.', error_code: 'not_connected' });
    }

    const idem = this.deps.idempotency;

    if (idempotencyKey !== null) {
      const begun = idem.begin(idempotencyKey, ref);

      if (begun.state === 'done') {
        return { httpStatus: begun.result.error_code === 'not_on_whatsapp' ? 422 : 200, body: begun.result };
      }

      if (begun.state === 'in_progress') {
        return this.reply(409, { error: 'Pesan dengan kunci ini sedang dikirim.', error_code: 'in_progress' });
      }

      if (begun.state === 'uncertain') {
        return this.reply(200, { error: 'Pengiriman sebelumnya terhenti di tengah; pesan mungkin sudah keluar.', error_code: 'uncertain', message_id: begun.message_id });
      }
    }

    const sock = this.sock;
    let recipient;

    try {
      recipient = await this.lookupRecipient(sock, to);
    } catch (error) {
      if (idempotencyKey !== null) {
        idem.abandon(idempotencyKey);
      }

      return this.reply(503, { error: `Gagal memeriksa nomor tujuan: ${error.message}`, error_code: 'not_connected' });
    }

    if (!recipient.exists) {
      const result = { success: false, message_id: null, server_ack: false, error: 'Nomor tidak terdaftar di WhatsApp.', error_code: 'not_on_whatsapp' };

      if (idempotencyKey !== null) {
        idem.complete(idempotencyKey, result);
      }

      return { httpStatus: 422, body: result };
    }

    const messageId = this.deps.generateMessageId(sock);

    if (idempotencyKey !== null) {
      idem.attachMessageId(idempotencyKey, messageId);
    }

    idem.rememberRef(messageId, ref);
    this.rememberText(messageId, message);
    const serverAck = this.waitForServerAck(messageId, SERVER_ACK_WAIT_MS);

    try {
      await sock.sendMessage(recipient.jid, { text: message }, { messageId });
    } catch (error) {
      this.logger.warn({ error: error.message }, 'sendMessage gagal; hasil tidak pasti');
      const result = { success: false, message_id: messageId, server_ack: false, error: `Pengiriman terputus: ${error.message}`, error_code: 'uncertain' };

      if (idempotencyKey !== null) {
        idem.complete(idempotencyKey, result);
      }

      return { httpStatus: 200, body: result };
    }

    const result = { success: true, message_id: messageId, server_ack: await serverAck, error: null, error_code: null };

    if (idempotencyKey !== null) {
      idem.complete(idempotencyKey, result);
    }

    return { httpStatus: 200, body: result };
  }

  reply(httpStatus, body) {
    return { httpStatus, body: { success: false, message_id: null, server_ack: false, error: null, error_code: null, ...body } };
  }

  async lookupRecipient(sock, number) {
    const cached = this.deps.recipients.get(number);

    if (cached) {
      return cached;
    }

    const results = (await sock.onWhatsApp(number)) ?? [];
    const found = results.find((item) => item?.exists);
    const recipient = { exists: Boolean(found), jid: found?.jid ?? null };
    this.deps.recipients.set(number, recipient.exists, recipient.jid);

    return recipient;
  }

  rememberText(messageId, text) {
    const now = this.deps.now();

    for (const [id, item] of this.texts) {
      if (item.until > now) {
        break;
      }

      this.texts.delete(id);
    }

    this.texts.set(messageId, { text, until: now + MESSAGE_TEXT_TTL_MS });
  }

  /** Untuk permintaan kirim ulang dari perangkat penerima (retry receipt). */
  getMessage(key) {
    const item = this.texts.get(key?.id);

    if (!item || item.until <= this.deps.now()) {
      return undefined;
    }

    return { conversation: item.text };
  }

  waitForServerAck(messageId, timeoutMs) {
    if (this.recentAcks.has(messageId)) {
      return Promise.resolve(true);
    }

    return new Promise((resolve) => {
      const timer = this.deps.setTimer(() => {
        this.ackWaiters.delete(messageId);
        resolve(false);
      }, timeoutMs);
      this.ackWaiters.set(messageId, (acked) => {
        this.deps.clearTimer(timer);
        this.ackWaiters.delete(messageId);
        resolve(acked);
      });
    });
  }

  failAckWaiters() {
    for (const resolve of [...this.ackWaiters.values()]) {
      resolve(false);
    }
  }

  onServerAck(node) {
    const id = node?.attrs?.id;

    if (!id) {
      return;
    }

    if (node.attrs.error) {
      this.ackWaiters.get(id)?.(false);
      this.emitAck(id, 'error', String(node.attrs.error));

      return;
    }

    this.recentAcks.set(id, this.deps.now());

    if (this.recentAcks.size > 1000) {
      this.recentAcks.delete(this.recentAcks.keys().next().value);
    }

    this.ackWaiters.get(id)?.(true);
    this.emitAck(id, 'server', null);
  }

  onMessagesUpdate(updates) {
    for (const { key, update } of updates ?? []) {
      if (!key?.fromMe || update?.status === undefined || update?.status === null) {
        continue;
      }

      const ack = RECEIPT_STATUS[update.status];

      if (ack) {
        this.emitAck(key.id, ack, ack === 'error' ? 'status error' : null);
      }
    }
  }

  emitAck(messageId, ack, error) {
    const ref = this.deps.idempotency.refFor(messageId);

    // Pesan tanpa ref (bukan dari aplikasi) tidak pernah dilaporkan.
    if (ref === null) {
      return;
    }

    this.deps.emit({ type: 'message.ack', session: this.key, ref, message_id: messageId, ack, error });
  }

  async logout() {
    this.manualStop = true;
    this.clearTimer('reconnectTimer');

    if (this.sock && this.status === 'online') {
      this.loggingOut = true;

      try {
        await this.sock.logout();
      } finally {
        // Bila event close tidak datang, folder tetap dibersihkan di sini.
        if (this.status !== 'logged_out') {
          this.onClose(DISCONNECT.loggedOut);
        }
      }

      return this.snapshot();
    }

    this.sock?.end(undefined);
    this.sock = null;
    this.loggingOut = false;
    this.deps.removeDir(this.dir);
    this.stopLease(true);
    this.setStatus('logged_out', { jid: null, name: null });

    return this.snapshot();
  }

  /**
   * Berhenti tanpa logout (shutdown rapi / pindah mesin): kredensial tetap
   * di disk, lease dilepas supaya node lain boleh mengambil alih.
   */
  async stop() {
    this.manualStop = true;
    this.clearTimer('reconnectTimer');
    const sock = this.sock;
    this.sock = null;
    sock?.end(undefined);
    this.failAckWaiters();

    // lease_denied = sesi dipegang node/proses lain: "offline" dari sini akan
    // menimpa status pemegang di aplikasi.
    if (!['logged_out', 'blocked', 'replaced', 'lease_denied'].includes(this.status)) {
      this.setStatus('offline', { reason: 'wa-service dihentikan' });
    }

    await this.stopLease(true);
  }
}
