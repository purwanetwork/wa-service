import path from 'node:path';

/**
 * Kunci sesi dibuat aplikasi (mis. "s" + 16 hex, atau "platform") dan
 * dipakai sebagai nama folder: hanya huruf kecil, angka, "_" dan "-",
 * 3-64 karakter, diawali huruf/angka. Pola yang sama divalidasi di aplikasi
 * (App\Models\WhatsappSession::KEY_PATTERN).
 */
export const SESSION_KEY_PATTERN = /^[a-z0-9][a-z0-9_-]{2,63}$/;

export function isValidSessionKey(key) {
  return typeof key === 'string' && SESSION_KEY_PATTERN.test(key);
}

export class InvalidSessionKeyError extends Error {}

/**
 * Folder sesi $key di dalam $sessionsDir. Kunci tidak sah atau jalur yang
 * (setelah di-resolve) keluar dari $sessionsDir ditolak, jadi logout/hapus
 * tidak pernah menyentuh folder lain.
 */
export function resolveSessionDir(sessionsDir, key) {
  if (!isValidSessionKey(key)) {
    throw new InvalidSessionKeyError('kunci sesi tidak sah');
  }

  const root = path.resolve(sessionsDir);
  const dir = path.resolve(root, key);

  if (path.dirname(dir) !== root || dir === root) {
    throw new InvalidSessionKeyError('jalur sesi di luar folder sesi');
  }

  return dir;
}
