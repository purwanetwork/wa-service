import crypto from 'node:crypto';
import { addressAllowed } from './network.js';

/**
 * Token dibandingkan waktu-konstan (W6): kedua sisi di-hash SHA-256 dulu
 * supaya panjangnya sama, lalu crypto.timingSafeEqual.
 */
export function tokensMatch(given, expected) {
  if (typeof given !== 'string' || typeof expected !== 'string' || expected === '') {
    return false;
  }

  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(expected).digest();

  return crypto.timingSafeEqual(a, b);
}

export function bearerAuth(expectedToken) {
  return (req, res, next) => {
    const header = req.headers.authorization || '';
    const match = /^Bearer (\S+)$/.exec(header);

    if (!match || !tokensMatch(match[1], expectedToken)) {
      return res.status(401).json({ error: 'Unauthorized', error_code: 'unauthorized' });
    }

    next();
  };
}

/**
 * Hanya IP di WA_ALLOWED_IPS yang dilayani (bawaan: loopback). Dicek
 * sebelum token, jadi mesin lain tidak bisa menebak token.
 */
export function ipAllowlist(allowedIps) {
  return (req, res, next) => {
    if (!addressAllowed(allowedIps, req.socket?.remoteAddress)) {
      return res.status(403).json({ error: 'Forbidden', error_code: 'forbidden' });
    }

    next();
  };
}
