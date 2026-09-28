import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Kunci lokal sesi (<folder sesi>/.lock, 0600): dua proses wa-service di
 * mesin yang sama (mis. lab yang salah menunjuk SESSIONS_DIR produksi)
 * tidak bisa memegang sesi yang sama. Kunci milik proses yang sudah mati
 * diambil alih. Kunci dari MESIN LAIN (folder disalin dari mesin lama tanpa
 * stop yang rapi) tidak bisa diperiksa dari sini:
 * - mode lease "app": diteruskan, lease aplikasi yang memutuskan;
 * - mode lease "local": ditolak sampai pemilik menghapus .lock setelah
 *   memastikan wa-service di mesin lama berhenti.
 */
export const LOCK_FILE = '.lock';

function processAlive(pid) {
  try {
    process.kill(pid, 0);

    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

export function createSessionLock({ dir, node, bootId, leaseMode, hostname = os.hostname(), pid = process.pid, isAlive = processAlive }) {
  const file = path.join(dir, LOCK_FILE);
  let held = false;

  return {
    /**
     * @returns {{ok: boolean, reason?: string}}
     */
    acquire() {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      let current = null;

      try {
        current = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch {
        current = null;
      }

      if (current && !(current.host === hostname && current.pid === pid)) {
        if (current.host === hostname && isAlive(current.pid)) {
          return { ok: false, reason: 'sesi dipegang proses wa-service lain di mesin ini' };
        }

        if (current.host !== hostname && leaseMode !== 'app') {
          return { ok: false, reason: 'kunci sesi dari mesin lain; hapus .lock setelah wa-service di mesin lama berhenti' };
        }
      }

      fs.writeFileSync(file, JSON.stringify({ host: hostname, pid, node, boot_id: bootId, at: new Date().toISOString() }), { mode: 0o600 });
      held = true;

      return { ok: true };
    },

    release() {
      if (!held) {
        return;
      }

      held = false;

      try {
        const current = JSON.parse(fs.readFileSync(file, 'utf8'));

        if (current.host === hostname && current.pid === pid) {
          fs.rmSync(file, { force: true });
        }
      } catch {
        // Folder sudah dihapus (logout): tidak ada yang dilepas.
      }
    },
  };
}
