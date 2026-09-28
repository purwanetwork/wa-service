import fs from 'node:fs';
import path from 'node:path';
import pino from 'pino';

/**
 * Log wa-service ditulis proses sendiri ke LOG_DIR/wa-service.log (0640),
 * bukan lewat append systemd (root 0644). Yang TIDAK PERNAH masuk log:
 * QR/kode pairing, materi kunci sesi libsignal, nomor utuh, JID/@lid.
 *
 * - redact: kunci yang biasa memuat JID/nomor (jid, remoteJid, participant,
 *   from, to, phone, key, attrs) di level atas dan dua level ke dalam.
 * - scrub: setiap teks (pesan log dan nilai string objek) disaring dari
 *   pola JID dan nomor Indonesia.
 * - console.* dibungkus (wrapConsole): baris libsignal tentang sesi (yang
 *   mencetak SessionEntry lengkap) dibuang dan hanya dihitung; baris lain
 *   diteruskan sebagai teks saja, objeknya tidak pernah ikut.
 */
export const REDACT_KEYS = ['jid', 'remoteJid', 'participant', 'from', 'to', 'phone', 'key', 'attrs', 'qr', 'pairingCode', 'pairing_code', 'text'];

export const REDACT_PATHS = [
  ...REDACT_KEYS,
  ...REDACT_KEYS.map((key) => `*.${key}`),
  ...REDACT_KEYS.map((key) => `*.*.${key}`),
];

const JID_PATTERN = /[\w.:+-]*@(s\.whatsapp\.net|lid|c\.us|g\.us|broadcast|newsletter)\b/gi;
const PHONE_PATTERN = /\+?\b62\d{7,13}\b/g;

export function scrubText(text) {
  return String(text).replace(JID_PATTERN, '[jid]').replace(PHONE_PATTERN, '[nomor]');
}

function scrubValue(value, depth = 0) {
  if (typeof value === 'string') {
    return scrubText(value);
  }

  if (value === null || typeof value !== 'object' || depth > 4) {
    return value;
  }

  if (value instanceof Error) {
    return { type: value.name, message: scrubText(value.message) };
  }

  if (Array.isArray(value)) {
    return value.slice(0, 20).map((item) => scrubValue(item, depth + 1));
  }

  const result = {};

  for (const [key, item] of Object.entries(value)) {
    result[key] = scrubValue(item, depth + 1);
  }

  return result;
}

/**
 * Baris console libsignal yang dibuang seluruhnya (mencetak objek sesi
 * beserta rootKey/privKey/chainKey, atau hanya derau). Kunci = label hitungan.
 */
export const DROPPED_CONSOLE_PATTERNS = [
  ['closing_session', /^Closing session/],
  ['opening_session', /^Opening session/],
  ['removing_closed_session', /^Removing old closed session/],
  ['session_already_closed', /^Session already closed/],
  ['session_already_open', /^Session already open/],
  ['closing_open_session', /^Closing open session/],
  ['decrypted_with_closed_session', /^Decrypted message with closed session/],
  ['migrating_session', /^Migrating session/],
];

/**
 * @param {{ logDir?: string, level?: string, destination?: import('node:stream').Writable }} options
 */
export function createLogger({ logDir, level = 'info', destination } = {}) {
  let stream = destination;

  if (!stream) {
    fs.mkdirSync(logDir, { recursive: true, mode: 0o750 });
    const file = path.join(logDir, 'wa-service.log');
    fs.closeSync(fs.openSync(file, 'a', 0o640));
    // UMask=0077 unit menghasilkan 0600; grup adm tetap boleh membaca.
    fs.chmodSync(file, 0o640);
    stream = pino.destination({ dest: file, append: true, sync: false });
  }

  return pino(
    {
      level,
      base: { pid: process.pid },
      redact: { paths: REDACT_PATHS, censor: '[disamarkan]' },
      formatters: {
        log: (object) => scrubValue(object),
      },
      hooks: {
        logMethod(args, method) {
          method.apply(
            this,
            args.map((arg) => (typeof arg === 'string' ? scrubText(arg) : arg)),
          );
        },
      },
    },
    stream,
  );
}

/**
 * Logger untuk Baileys: child level warn (bukan info: log internal Baileys
 * penuh JID dan tidak berguna sehari-hari).
 */
export function baileysLogger(logger, level = 'warn') {
  const child = logger.child({ mod: 'baileys' });
  child.level = level;

  return child;
}

/**
 * Ganti console.log/info/warn/error/debug milik proses. Mengembalikan
 * penghitung baris yang dibuang dan fungsi pemulih (untuk tes).
 */
export function wrapConsole(logger, target = console) {
  const dropped = {};
  const original = {};
  const levels = { log: 'info', info: 'info', debug: 'debug', warn: 'warn', error: 'error' };

  for (const [name, level] of Object.entries(levels)) {
    original[name] = target[name];
    target[name] = (first, ...rest) => {
      const text = typeof first === 'string' ? first : '';

      for (const [label, pattern] of DROPPED_CONSOLE_PATTERNS) {
        if (pattern.test(text)) {
          dropped[label] = (dropped[label] ?? 0) + 1;

          return;
        }
      }

      // Hanya teks; objek (sesi, bucket, error berisi JID) tidak diteruskan.
      logger[level]({ console: name, dropped_args: rest.length }, text === '' ? '[console tanpa teks]' : text);
    };
  }

  return {
    dropped,
    restore() {
      Object.assign(target, original);
    },
  };
}
