import crypto from 'node:crypto';

/**
 * Tanda tangan callback dan jawaban lease:
 *   X-Wa-Signature: t=<unix detik>,v1=<hex HMAC-SHA256(secret, "<t>.<body>")>
 * Format yang sama diperiksa aplikasi (App\Http\Middleware\VerifyWaServiceSignature)
 * dengan vektor uji bersama (test/fixtures/hmac-vector.json).
 */
export const SIGNATURE_HEADER = 'x-wa-signature';

export const MAX_SKEW_SECONDS = 300;

export function sign(secret, body, timestamp) {
  const v1 = crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');

  return `t=${timestamp},v1=${v1}`;
}

export function verify(secret, body, header, nowSeconds = Math.floor(Date.now() / 1000)) {
  const match = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(String(header ?? ''));

  if (!match) {
    return false;
  }

  const timestamp = Number(match[1]);

  if (Math.abs(nowSeconds - timestamp) > MAX_SKEW_SECONDS) {
    return false;
  }

  const expected = Buffer.from(sign(secret, body, timestamp).slice(-64), 'hex');

  return crypto.timingSafeEqual(expected, Buffer.from(match[2], 'hex'));
}
