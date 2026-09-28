import crypto from 'node:crypto';
import path from 'node:path';
import { postJson } from './httpTransport.js';
import { readJson, writeJsonAtomic } from './jsonFile.js';
import { sign, SIGNATURE_HEADER } from './signature.js';

/**
 * Event ke aplikasi (POST WA_CALLBACK_URL, bertanda tangan HMAC): status sesi
 * dan ack pesan. Tahan saat aplikasi mati: antrean disimpan di
 * STATE_DIR/spool.json (0600, maks. 10.000 event; yang tertua dibuang dan
 * dihitung), dikirim ulang dengan jeda naik, dan dimuat lagi saat start.
 * Event hanya dihapus setelah aplikasi menjawab 2xx.
 *
 * seq naik terus, juga lintas restart (maks(seq terakhir + 1, waktu dalam
 * mikrodetik)): aplikasi menolak status sesi dengan seq yang tidak lebih baru.
 */
export const BACKOFF_SECONDS = [2, 5, 15, 60, 300];

export class CallbackSender {
  constructor({
    url,
    secret,
    hostHeader = null,
    node,
    bootId,
    stateDir,
    logger,
    transport = postJson,
    now = () => Date.now(),
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    maxEvents = 10000,
    batchSize = 100,
  }) {
    Object.assign(this, { url, secret, hostHeader, node, bootId, logger, transport, now, setTimer, clearTimer, maxEvents, batchSize });
    this.file = path.join(stateDir, 'spool.json');
    const data = readJson(this.file, {});
    this.events = Array.isArray(data.events) ? data.events : [];
    this.dropped = Number(data.dropped ?? 0);
    this.lastSeq = Number(data.last_seq ?? 0);
    this.attempt = 0;
    this.timer = null;
    this.inflight = null;
    this.lastOkAt = null;
    this.lastErrorAt = null;
    this.lastError = null;
    this.stopped = false;
  }

  nextSeq() {
    this.lastSeq = Math.max(this.lastSeq + 1, this.now() * 1000);

    return this.lastSeq;
  }

  enqueue(event) {
    this.events.push({ id: crypto.randomUUID(), seq: this.nextSeq(), at: new Date(this.now()).toISOString(), ...event });

    while (this.events.length > this.maxEvents) {
      this.events.shift();
      this.dropped++;
    }

    this.persist();
    this.schedule(0);
  }

  schedule(delayMs) {
    if (this.stopped || this.timer !== null || this.inflight !== null || this.events.length === 0) {
      return;
    }

    this.timer = this.setTimer(() => {
      this.timer = null;
      this.flush().catch(() => {});
    }, delayMs);
  }

  async flush() {
    if (this.inflight !== null || this.events.length === 0) {
      return this.inflight;
    }

    const batch = this.events.slice(0, this.batchSize);
    const body = JSON.stringify({ node: this.node, boot_id: this.bootId, events: batch });
    const headers = { [SIGNATURE_HEADER]: sign(this.secret, body, Math.floor(this.now() / 1000)) };

    this.inflight = (async () => {
      try {
        const response = await this.transport(this.url, body, headers, { hostHeader: this.hostHeader });

        if (response.status < 200 || response.status >= 300) {
          throw new Error(`HTTP ${response.status}`);
        }

        const sent = new Set(batch.map((event) => event.id));
        this.events = this.events.filter((event) => !sent.has(event.id));
        this.attempt = 0;
        this.lastOkAt = this.now();
        this.persist();
      } catch (error) {
        this.lastErrorAt = this.now();

        if (this.lastError !== error.message) {
          this.logger?.warn({ pending: this.events.length, error: error.message }, 'callback ke aplikasi gagal');
        }

        this.lastError = error.message;
        this.attempt++;
      } finally {
        this.inflight = null;
      }

      if (this.events.length > 0) {
        const delay = this.attempt === 0 ? 0 : BACKOFF_SECONDS[Math.min(this.attempt, BACKOFF_SECONDS.length) - 1] * 1000;
        this.schedule(delay);
      }
    })();

    return this.inflight;
  }

  persist() {
    writeJsonAtomic(this.file, { events: this.events, dropped: this.dropped, last_seq: this.lastSeq });
  }

  status() {
    return {
      pending: this.events.length,
      dropped: this.dropped,
      last_ok_at: this.lastOkAt ? new Date(this.lastOkAt).toISOString() : null,
      last_error_at: this.lastErrorAt ? new Date(this.lastErrorAt).toISOString() : null,
    };
  }

  stop() {
    this.stopped = true;

    if (this.timer !== null) {
      this.clearTimer(this.timer);
      this.timer = null;
    }

    this.persist();
  }
}
