import fs from 'node:fs';
import path from 'node:path';

/**
 * Baca/tulis file JSON state (0600). Tulis atomik: file sementara di folder
 * yang sama lalu rename, jadi proses mati di tengah tidak meninggalkan file
 * setengah jadi.
 */
export function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export function writeJsonAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, typeof data === 'string' ? data : JSON.stringify(data), { mode: 0o600 });
  fs.renameSync(tmp, file);
}
