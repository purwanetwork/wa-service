import net from 'node:net';

/**
 * Alamat IP dan jaringan: daftar IP pemanggil yang diizinkan dan pemeriksaan
 * keamanan transport (http hanya ke loopback atau jaringan privat yang
 * diizinkan, selain itu wajib https).
 */

/** Alamat IPv4 yang dibungkus IPv6 (::ffff:127.0.0.1) dijadikan IPv4 biasa. */
export function normalizeIp(address) {
  if (typeof address !== 'string') {
    return '';
  }

  const trimmed = address.trim().replace(/^\[|\]$/g, '');

  return trimmed.toLowerCase().startsWith('::ffff:') && net.isIPv4(trimmed.slice(7)) ? trimmed.slice(7) : trimmed;
}

export function isLoopback(address) {
  const ip = normalizeIp(address);

  return ip === '::1' || (net.isIPv4(ip) && ip.startsWith('127.'));
}

/**
 * Daftar "1.2.3.4, 10.0.0.0/24, ::1" menjadi BlockList. Entri tidak sah
 * melempar Error (config ditolak saat start).
 */
export function parseAddressList(value) {
  const list = new net.BlockList();
  const entries = String(value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');

  for (const entry of entries) {
    const [address, prefix] = entry.split('/');
    const ip = normalizeIp(address);
    const family = net.isIPv4(ip) ? 'ipv4' : net.isIPv6(ip) ? 'ipv6' : null;

    if (family === null) {
      throw new Error(`alamat tidak sah: ${entry}`);
    }

    if (prefix === undefined) {
      list.addAddress(ip, family);
      continue;
    }

    const bits = Number(prefix);
    const max = family === 'ipv4' ? 32 : 128;

    if (!/^\d+$/.test(prefix) || bits < 1 || bits > max) {
      throw new Error(`prefix jaringan tidak sah: ${entry}`);
    }

    list.addSubnet(ip, bits, family);
  }

  return { list, entries };
}

export function addressAllowed(parsed, address) {
  const ip = normalizeIp(address);

  if (net.isIPv4(ip)) {
    return parsed.list.check(ip, 'ipv4');
  }

  if (net.isIPv6(ip)) {
    return parsed.list.check(ip, 'ipv6');
  }

  return false;
}

/**
 * Masalah keamanan transport URL, atau null bila aman: https selalu boleh;
 * http hanya ke loopback (localhost/127.x/::1) atau ke IP literal di
 * jaringan privat yang diizinkan ($privateNetworks, mis. subnet WireGuard).
 */
export function transportProblem(url, privateNetworks) {
  let parsed;

  try {
    parsed = new URL(url);
  } catch {
    return 'bukan URL yang sah';
  }

  if (parsed.protocol === 'https:') {
    return null;
  }

  if (parsed.protocol !== 'http:') {
    return 'protokol harus http atau https';
  }

  const host = normalizeIp(parsed.hostname);

  if (host === 'localhost' || isLoopback(host)) {
    return null;
  }

  if ((net.isIP(host) !== 0) && addressAllowed(privateNetworks, host)) {
    return null;
  }

  return 'http tanpa TLS hanya boleh ke localhost atau IP di jaringan privat yang diizinkan (WA_PRIVATE_NETWORKS); pakai https atau jalur WireGuard';
}
