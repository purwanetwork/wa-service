import { postJson } from './httpTransport.js';
import { sign, verify, SIGNATURE_HEADER } from './signature.js';

/**
 * Lease sesi dari aplikasi: pengaman supaya DUA wa-service (mis. lama dan
 * baru saat pindah ke VM) tidak memegang sesi yang sama bersamaan.
 * Aplikasi (satu database) memberi lease per sesi ke satu node dengan masa
 * berlaku; wa-service hanya menyambung bila lease diberikan, memperbarui
 * tiap sepertiga masa berlaku, dan melepas socket (tanpa logout) bila
 * lease ditolak karena dipegang node lain.
 *
 * Jawaban aplikasi WAJIB bertanda tangan (secret callback yang sama): URL
 * salah, proxy, atau 404 aplikasi lama tidak pernah dianggap "diberikan".
 *
 * Mode "local" (WA_SESSION_LEASE=local) hanya untuk aplikasi yang belum
 * punya endpoint lease (deploy tahap 1): tanpa pengaman lintas mesin,
 * hanya kunci lokal (sessionLock.js).
 */
export const LEASE_TTL_SECONDS = 120;

export function leaseUrlFrom(callbackUrl) {
  return new URL('lease', callbackUrl).toString();
}

export function createLeaseClient({ mode, url, secret, hostHeader = null, node, bootId, transport = postJson, now = () => Date.now() }) {
  async function call(action, session) {
    if (mode === 'local') {
      return { granted: true, reason: 'local', transient: false };
    }

    const body = JSON.stringify({ action, session, node, boot_id: bootId });
    const headers = { [SIGNATURE_HEADER]: sign(secret, body, Math.floor(now() / 1000)) };
    let response;

    try {
      response = await transport(url, body, headers, { hostHeader });
    } catch (error) {
      return { granted: false, reason: `aplikasi tidak terjangkau (${error.message})`, transient: true };
    }

    const signature = response.headers?.[SIGNATURE_HEADER];

    if (response.status !== 200 || !verify(secret, response.body, signature, Math.floor(now() / 1000))) {
      return { granted: false, reason: `jawaban lease tidak sah (HTTP ${response.status})`, transient: true };
    }

    let data;

    try {
      data = JSON.parse(response.body);
    } catch {
      return { granted: false, reason: 'jawaban lease bukan JSON', transient: true };
    }

    if (data.session !== session || data.node !== node) {
      return { granted: false, reason: 'jawaban lease untuk sesi/node lain', transient: true };
    }

    return { granted: data.granted === true, reason: String(data.reason ?? ''), transient: false, ttl: Number(data.ttl ?? LEASE_TTL_SECONDS) };
  }

  return {
    mode,
    acquire: (session) => call('acquire', session),
    renew: (session) => call('renew', session),
    release: (session) => call('release', session),
  };
}
