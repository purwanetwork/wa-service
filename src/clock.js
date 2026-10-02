/**
 * Waktu yang dikirim ke aplikasi (event callback, /health, /status): ISO 8601
 * dengan offset zona aplikasi, mis. "2026-10-02T12:00:00.000+07:00", BUKAN
 * UTC "Z". Aplikasi (APP_TIMEZONE=Asia/Jakarta) menyimpan jam dari string ini
 * tanpa konversi zona, jadi "Z" membuat jam mundur 7 jam (B-1).
 *
 * Zona diambil eksplisit lewat Intl (timeZone), TIDAK dari TZ proses atau
 * unit systemd, jadi hasilnya sama walau proses berjalan dengan TZ=UTC.
 */
export const APP_TIME_ZONE = 'Asia/Jakarta';

const pad = (value, length = 2) => String(value).padStart(length, '0');

const formatters = new Map();

function formatterFor(timeZone) {
  if (!formatters.has(timeZone)) {
    formatters.set(timeZone, new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }));
  }

  return formatters.get(timeZone);
}

/**
 * @param {number|Date} at milidetik epoch atau Date
 * @param {string} timeZone zona IANA (bawaan Asia/Jakarta)
 */
export function isoWithOffset(at, timeZone = APP_TIME_ZONE) {
  const ms = at instanceof Date ? at.getTime() : Number(at);

  if (!Number.isFinite(ms)) {
    throw new RangeError('waktu tidak sah');
  }

  const parts = Object.fromEntries(formatterFor(timeZone).formatToParts(new Date(ms)).map((part) => [part.type, part.value]));
  const millis = ((ms % 1000) + 1000) % 1000;
  const wallMs = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second), millis);
  const offsetMinutes = Math.round((wallMs - ms) / 60000);
  const sign = offsetMinutes < 0 ? '-' : '+';
  const absolute = Math.abs(offsetMinutes);

  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}.${pad(millis, 3)}`
    + `${sign}${pad(Math.floor(absolute / 60))}:${pad(absolute % 60)}`;
}
