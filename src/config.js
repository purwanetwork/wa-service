import os from 'node:os';
import path from 'node:path';
import { isLoopback, parseAddressList, transportProblem } from './network.js';
import { isValidSessionKey } from './sessionKey.js';

/**
 * Semua alamat, rahasia, dan folder dari env (tanpa asumsi localhost di kode
 * selain nilai bawaan). Nilai bawaan = perilaku satu mesin: listen
 * 127.0.0.1:3901, hanya loopback yang boleh memanggil.
 *
 * Start DITOLAK (Error) bila: token/secret callback kosong atau secret < 32
 * karakter, URL callback tidak aman (http ke alamat publik), listen di
 * alamat bukan loopback tanpa WA_ALLOWED_IPS eksplisit, kunci sesi lama
 * tidak sah, atau mode lease tidak dikenal.
 */
export const DEFAULTS = Object.freeze({
  HOST: '127.0.0.1',
  PORT: '3901',
  WA_ALLOWED_IPS: '127.0.0.1,::1',
  MAX_SESSIONS: '6',
  WA_SESSION_LEASE: 'app',
  LOG_LEVEL: 'info',
});

export const LEASE_MODES = ['app', 'local'];

export class ConfigError extends Error {}

export function loadConfig(env = process.env, baseDir = process.cwd()) {
  const problems = [];
  const read = (name) => (env[name] ?? '').toString().trim();
  const readOr = (name) => read(name) || DEFAULTS[name];

  const token = read('WA_SERVICE_TOKEN');
  const callbackSecret = read('WA_CALLBACK_SECRET');
  const callbackUrl = read('WA_CALLBACK_URL');
  const legacySessionKey = read('WA_LEGACY_SESSION_KEY') || null;
  const host = readOr('HOST');
  const port = Number(readOr('PORT'));
  const maxSessions = Number(readOr('MAX_SESSIONS'));
  const leaseMode = readOr('WA_SESSION_LEASE');

  if (token === '') {
    problems.push('WA_SERVICE_TOKEN kosong');
  }

  if (callbackSecret.length < 32) {
    problems.push('WA_CALLBACK_SECRET kosong atau kurang dari 32 karakter');
  }

  if (callbackSecret !== '' && callbackSecret === token) {
    problems.push('WA_CALLBACK_SECRET harus berbeda dari WA_SERVICE_TOKEN');
  }

  if (legacySessionKey !== null && !isValidSessionKey(legacySessionKey)) {
    problems.push('WA_LEGACY_SESSION_KEY tidak sah (huruf kecil/angka/_/-, 3-64 karakter)');
  }

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    problems.push('PORT tidak sah');
  }

  if (!Number.isInteger(maxSessions) || maxSessions < 1 || maxSessions > 100) {
    problems.push('MAX_SESSIONS harus 1-100');
  }

  if (!LEASE_MODES.includes(leaseMode)) {
    problems.push(`WA_SESSION_LEASE harus salah satu dari: ${LEASE_MODES.join(', ')}`);
  }

  let allowedIps = null;
  let privateNetworks = null;

  try {
    allowedIps = parseAddressList(readOr('WA_ALLOWED_IPS'));
  } catch (error) {
    problems.push(`WA_ALLOWED_IPS: ${error.message}`);
  }

  try {
    privateNetworks = parseAddressList(read('WA_PRIVATE_NETWORKS'));
  } catch (error) {
    problems.push(`WA_PRIVATE_NETWORKS: ${error.message}`);
  }

  // Listen di alamat selain loopback (mis. IP WireGuard di VM terpisah) =
  // bisa dijangkau mesin lain: daftar pemanggil wajib ditulis sendiri.
  if (!isLoopback(host) && host !== 'localhost' && read('WA_ALLOWED_IPS') === '') {
    problems.push('HOST bukan loopback: WA_ALLOWED_IPS wajib diisi (IP aplikasi)');
  }

  if (callbackUrl === '') {
    problems.push('WA_CALLBACK_URL kosong');
  } else if (privateNetworks) {
    const problem = transportProblem(callbackUrl, privateNetworks);

    if (problem !== null) {
      problems.push(`WA_CALLBACK_URL: ${problem}`);
    }
  }

  if (problems.length > 0) {
    throw new ConfigError(`Konfigurasi wa-service tidak sah: ${problems.join('; ')}.`);
  }

  const resolveDir = (name, fallback) => path.resolve(baseDir, read(name) || fallback);

  return Object.freeze({
    host,
    port,
    token,
    callbackUrl,
    // Host/SNI untuk callback bila URL memakai IP (mis. https://127.0.0.1 ke
    // nginx lokal): header Host dan nama sertifikat yang diperiksa.
    callbackHost: read('WA_CALLBACK_HOST') || null,
    callbackSecret,
    legacySessionKey,
    maxSessions,
    leaseMode,
    allowedIps,
    privateNetworks,
    sessionsDir: resolveDir('SESSIONS_DIR', 'sessions'),
    stateDir: resolveDir('STATE_DIR', 'state'),
    logDir: resolveDir('LOG_DIR', 'logs'),
    nodeName: read('NODE_NAME') || os.hostname(),
    logLevel: readOr('LOG_LEVEL'),
  });
}
