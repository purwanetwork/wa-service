import fs from 'node:fs';
import path from 'node:path';
import { isLoggedIn } from './session.js';
import { isValidSessionKey, resolveSessionDir } from './sessionKey.js';

/**
 * Semua sesi dalam satu proses: kunci -> Session, batas MAX_SESSIONS, muat
 * otomatis sesi yang sudah login saat start, dan isolasi error per sesi
 * (satu sesi gagal tidak menghentikan sesi lain maupun proses).
 */
export const FILE_COUNT_CACHE_MS = 10 * 60 * 1000;

export class MaxSessionsError extends Error {}

export class SessionManager {
  /**
   * @param {object} options
   * @param {string} options.sessionsDir
   * @param {number} options.maxSessions
   * @param {(key: string, dir: string) => import('./session.js').Session} options.createSession
   * @param {object} options.logger
   */
  constructor({ sessionsDir, maxSessions, createSession, logger, now = () => Date.now() }) {
    this.sessionsDir = path.resolve(sessionsDir);
    this.maxSessions = maxSessions;
    this.createSession = createSession;
    this.logger = logger;
    this.now = now;
    this.sessions = new Map();
    this.ended = new Map();
    this.fileCounts = new Map();
    fs.mkdirSync(this.sessionsDir, { recursive: true, mode: 0o700 });
  }

  get(key) {
    return this.sessions.get(key) ?? null;
  }

  getOrCreate(key) {
    const existing = this.sessions.get(key);

    if (existing) {
      return existing;
    }

    for (const [otherKey, session] of this.sessions) {
      if (session.status === 'logged_out') {
        this.forget(otherKey);
      }
    }

    if (this.sessions.size >= this.maxSessions) {
      throw new MaxSessionsError(`batas ${this.maxSessions} sesi per wa-service tercapai`);
    }

    const session = this.createSession(key, resolveSessionDir(this.sessionsDir, key));
    this.sessions.set(key, session);
    this.ended.delete(key);

    return session;
  }

  /**
   * Status sesi tanpa membuatnya: sesi yang belum pernah ada = offline.
   */
  status(key) {
    const session = this.sessions.get(key);

    if (session) {
      return session.snapshot();
    }

    return this.ended.get(key) ?? { status: 'offline', qr: null, pairing_code: null, jid: null, name: null, reason: null, since: null };
  }

  /** Setelah logout: dilepas dari peta (tidak menghitung batas sesi). */
  forget(key) {
    const session = this.sessions.get(key);

    if (session) {
      this.ended.set(key, session.snapshot());
      this.sessions.delete(key);
    }
  }

  /**
   * Folder sesi yang sudah login (creds me && account) disambungkan
   * otomatis; folder setengah dipasangkan dan nama tidak sah dilewati.
   */
  async loadExisting() {
    let names = [];

    try {
      names = fs.readdirSync(this.sessionsDir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
    } catch (error) {
      this.logger.error({ error: error.message }, 'folder sesi tidak bisa dibaca');

      return [];
    }

    const started = [];

    for (const name of names) {
      if (!isValidSessionKey(name) || !isLoggedIn(this.readCreds(name))) {
        continue;
      }

      try {
        await this.getOrCreate(name).connect();
        started.push(name);
      } catch (error) {
        this.logger.error({ session: name, error: error.message }, 'sesi gagal dimuat; sesi lain tetap jalan');
      }
    }

    return started;
  }

  readCreds(key) {
    try {
      return JSON.parse(fs.readFileSync(path.join(resolveSessionDir(this.sessionsDir, key), 'creds.json'), 'utf8'));
    } catch {
      return null;
    }
  }

  fileCount(key) {
    const cached = this.fileCounts.get(key);

    if (cached && this.now() - cached.at < FILE_COUNT_CACHE_MS) {
      return cached.count;
    }

    let count = 0;

    try {
      count = fs.readdirSync(resolveSessionDir(this.sessionsDir, key)).length;
    } catch {
      count = 0;
    }

    this.fileCounts.set(key, { count, at: this.now() });

    return count;
  }

  /** Ringkasan untuk /health: status dan jumlah file per sesi, tanpa nomor/QR. */
  summary() {
    return [...this.sessions.values()].map((session) => ({
      key: session.key,
      status: session.status,
      files: this.fileCount(session.key),
    }));
  }

  async stopAll() {
    await Promise.all([...this.sessions.values()].map((session) => session.stop().catch(() => {})));
  }
}

/**
 * Hapus folder sesi $key (logout). Jalur dihitung ulang dan divalidasi di
 * sini, jadi hanya satu folder sesi di dalam SESSIONS_DIR yang bisa terhapus.
 */
export function removeSessionDir(sessionsDir, key) {
  fs.rmSync(resolveSessionDir(sessionsDir, key), { recursive: true, force: true });
}

/**
 * Sisihkan folder sesi yang setengah dipasangkan ke SESSIONS_DIR/.stale/
 * (bukan dihapus), supaya pairing baru mulai dari kosong.
 */
export function moveSessionDirAside(sessionsDir, key, now = Date.now()) {
  const dir = resolveSessionDir(sessionsDir, key);
  const staleDir = path.join(path.resolve(sessionsDir), '.stale');
  fs.mkdirSync(staleDir, { recursive: true, mode: 0o700 });
  fs.renameSync(dir, path.join(staleDir, `${key}-${now}`));
}
