import http from 'node:http';
import https from 'node:https';

/**
 * POST JSON ke aplikasi (callback event dan lease). $hostHeader (bila
 * diisi) menjadi header Host DAN nama TLS (SNI + pemeriksaan sertifikat),
 * sehingga https://127.0.0.1/... ke nginx lokal atau https://<IP WireGuard>/...
 * tetap memeriksa sertifikat domain aplikasi.
 *
 * @returns {Promise<{status: number, headers: object, body: string}>}
 */
export function postJson(url, body, headers, { hostHeader = null, timeoutMs = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const client = target.protocol === 'https:' ? https : http;
    const options = {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
        ...headers,
        ...(hostHeader ? { host: hostHeader } : {}),
      },
      timeout: timeoutMs,
      ...(hostHeader && target.protocol === 'https:' ? { servername: hostHeader } : {}),
    };

    const request = client.request(target, options, (response) => {
      const chunks = [];
      let size = 0;

      response.on('data', (chunk) => {
        size += chunk.length;

        if (size <= 65536) {
          chunks.push(chunk);
        }
      });
      response.on('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });

    request.on('timeout', () => request.destroy(new Error('batas waktu habis')));
    request.on('error', reject);
    request.end(body);
  });
}
