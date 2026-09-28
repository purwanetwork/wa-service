import path from 'node:path';
import { readJson, writeJsonAtomic } from './jsonFile.js';

/**
 * Store per sesi (STATE_DIR/idem-<kunci>.json, 0600), TTL 7 hari:
 * - entries: idempotency_key -> {state, ref, message_id, result, at}
 *   state: in_progress | done. Kunci yang sudah selesai mengembalikan hasil
 *   lama tanpa mengirim lagi; yang masih berjalan di proses ini = 409.
 *   Entri in_progress dari proses sebelumnya (mati di tengah kirim) menjadi
 *   "uncertain": pesan mungkin sudah keluar, jadi tidak dikirim ulang.
 * - refs: message_id WA -> ref aplikasi, untuk event ack. ID tanpa ref
 *   (mis. pesan yang diketik pemilik dari HP) tidak pernah dilaporkan.
 */
export const TTL_MS = 7 * 24 * 60 * 60 * 1000;

export class IdempotencyStore {
  constructor({ stateDir, sessionKey, now = () => Date.now(), ttlMs = TTL_MS }) {
    this.file = path.join(stateDir, `idem-${sessionKey}.json`);
    this.now = now;
    this.ttlMs = ttlMs;
    this.inProgress = new Set();

    const data = readJson(this.file, {});
    this.entries = data.entries ?? {};
    this.refs = data.refs ?? {};

    for (const entry of Object.values(this.entries)) {
      if (entry.state === 'in_progress') {
        entry.state = 'uncertain';
      }
    }

    this.prune();
  }

  /**
   * @returns {{state: 'new'} | {state: 'in_progress'} | {state: 'done', result: object} | {state: 'uncertain', message_id: ?string}}
   */
  begin(idempotencyKey, ref) {
    const existing = this.entries[idempotencyKey];

    if (existing) {
      if (existing.state === 'done') {
        return { state: 'done', result: existing.result };
      }

      if (this.inProgress.has(idempotencyKey)) {
        return { state: 'in_progress' };
      }

      return { state: 'uncertain', message_id: existing.message_id ?? null };
    }

    this.entries[idempotencyKey] = { state: 'in_progress', ref: ref ?? null, message_id: null, at: this.now() };
    this.inProgress.add(idempotencyKey);
    this.save();

    return { state: 'new' };
  }

  /** ID pesan sudah dibuat (sebelum dikirim): catat, supaya ack yang cepat punya ref. */
  attachMessageId(idempotencyKey, messageId) {
    const entry = this.entries[idempotencyKey];

    if (entry) {
      entry.message_id = messageId;
    }

    this.save();
  }

  complete(idempotencyKey, result) {
    this.inProgress.delete(idempotencyKey);
    const entry = this.entries[idempotencyKey];

    if (entry) {
      entry.state = 'done';
      entry.result = result;
      entry.at = this.now();
    }

    this.save();
  }

  /** Belum ada yang keluar (tidak tersambung, validasi): kunci boleh dipakai lagi. */
  abandon(idempotencyKey) {
    this.inProgress.delete(idempotencyKey);
    delete this.entries[idempotencyKey];
    this.save();
  }

  rememberRef(messageId, ref) {
    if (messageId && ref !== null && ref !== undefined && ref !== '') {
      this.refs[messageId] = { ref: String(ref), at: this.now() };
      this.save();
    }
  }

  refFor(messageId) {
    const item = this.refs[messageId];

    if (!item || this.now() - item.at > this.ttlMs) {
      return null;
    }

    return item.ref;
  }

  prune() {
    const cutoff = this.now() - this.ttlMs;

    for (const [key, entry] of Object.entries(this.entries)) {
      if (entry.at < cutoff && !this.inProgress.has(key)) {
        delete this.entries[key];
      }
    }

    for (const [id, item] of Object.entries(this.refs)) {
      if (item.at < cutoff) {
        delete this.refs[id];
      }
    }
  }

  save() {
    writeJsonAtomic(this.file, { entries: this.entries, refs: this.refs });
  }
}
