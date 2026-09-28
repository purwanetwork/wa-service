import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { loadConfig } from '../src/config.js';
import { addressAllowed, transportProblem, parseAddressList } from '../src/network.js';

const BASE = {
  WA_SERVICE_TOKEN: 'token-uji-0123456789',
  WA_CALLBACK_SECRET: 'rahasia-callback-uji-0123456789abcdef',
  WA_CALLBACK_URL: 'https://127.0.0.1/internal/wa-service/events',
};

test('nilai bawaan = perilaku satu mesin: 127.0.0.1:3901, hanya loopback', () => {
  const config = loadConfig(BASE, '/srv/wa');

  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.port, 3901);
  assert.equal(config.maxSessions, 6);
  assert.equal(config.leaseMode, 'app');
  assert.equal(config.sessionsDir, path.join('/srv/wa', 'sessions'));
  assert.equal(config.stateDir, path.join('/srv/wa', 'state'));
  assert.equal(addressAllowed(config.allowedIps, '127.0.0.1'), true);
  assert.equal(addressAllowed(config.allowedIps, '10.0.0.1'), false);
  assert.equal(config.legacySessionKey, null);
});

test('semua alamat dari env: HOST, PORT, WA_ALLOWED_IPS, callback, folder', () => {
  const config = loadConfig({
    ...BASE,
    HOST: '10.250.0.2',
    PORT: '3911',
    WA_ALLOWED_IPS: '10.250.0.1',
    WA_PRIVATE_NETWORKS: '10.250.0.0/30',
    WA_CALLBACK_URL: 'http://10.250.0.1:8080/internal/wa-service/events',
    WA_CALLBACK_HOST: 'app.example.test',
    SESSIONS_DIR: '/data/sessions',
    NODE_NAME: 'wa-vm-1',
    WA_LEGACY_SESSION_KEY: 's0123456789abcdef',
  }, '/srv/wa');

  assert.equal(config.host, '10.250.0.2');
  assert.equal(config.port, 3911);
  assert.equal(addressAllowed(config.allowedIps, '10.250.0.1'), true);
  assert.equal(addressAllowed(config.allowedIps, '127.0.0.1'), false);
  assert.equal(config.callbackHost, 'app.example.test');
  assert.equal(config.sessionsDir, '/data/sessions');
  assert.equal(config.nodeName, 'wa-vm-1');
  assert.equal(config.legacySessionKey, 's0123456789abcdef');
});

test('listen di alamat bukan loopback tanpa WA_ALLOWED_IPS ditolak', () => {
  assert.throws(() => loadConfig({ ...BASE, HOST: '0.0.0.0' }), /WA_ALLOWED_IPS wajib/);
  assert.throws(() => loadConfig({ ...BASE, HOST: '10.250.0.2' }), /WA_ALLOWED_IPS wajib/);
});

test('rahasia wajib: token kosong, secret pendek, atau secret = token ditolak', () => {
  assert.throws(() => loadConfig({ ...BASE, WA_SERVICE_TOKEN: '' }), /WA_SERVICE_TOKEN kosong/);
  assert.throws(() => loadConfig({ ...BASE, WA_CALLBACK_SECRET: 'pendek' }), /WA_CALLBACK_SECRET/);
  assert.throws(() => loadConfig({ ...BASE, WA_SERVICE_TOKEN: BASE.WA_CALLBACK_SECRET }), /berbeda/);
  assert.throws(() => loadConfig({ ...BASE, WA_CALLBACK_URL: '' }), /WA_CALLBACK_URL kosong/);
});

test('callback http ke alamat publik ditolak; http privat hanya bila jaringannya diizinkan', () => {
  assert.throws(() => loadConfig({ ...BASE, WA_CALLBACK_URL: 'http://203.0.113.10/internal/wa-service/events' }), /WA_CALLBACK_URL/);
  assert.throws(() => loadConfig({ ...BASE, WA_CALLBACK_URL: 'http://10.250.0.1/internal/wa-service/events' }), /WA_CALLBACK_URL/);
  assert.throws(() => loadConfig({ ...BASE, WA_CALLBACK_URL: 'http://app.example.test/x' }), /WA_CALLBACK_URL/);
  assert.doesNotThrow(() => loadConfig({ ...BASE, WA_CALLBACK_URL: 'http://10.250.0.1/x', WA_PRIVATE_NETWORKS: '10.250.0.0/30' }));
  assert.doesNotThrow(() => loadConfig({ ...BASE, WA_CALLBACK_URL: 'http://127.0.0.1/x' }));
  assert.doesNotThrow(() => loadConfig({ ...BASE, WA_CALLBACK_URL: 'https://app.example.test/x' }));
});

test('kunci sesi lama, mode lease, dan daftar alamat divalidasi', () => {
  assert.throws(() => loadConfig({ ...BASE, WA_LEGACY_SESSION_KEY: '../auth_session' }), /WA_LEGACY_SESSION_KEY/);
  assert.throws(() => loadConfig({ ...BASE, WA_SESSION_LEASE: 'mati' }), /WA_SESSION_LEASE/);
  assert.throws(() => loadConfig({ ...BASE, WA_ALLOWED_IPS: '10.0.0.0/99' }), /WA_ALLOWED_IPS/);
  assert.throws(() => loadConfig({ ...BASE, WA_ALLOWED_IPS: 'bukan-ip' }), /WA_ALLOWED_IPS/);
  assert.equal(loadConfig({ ...BASE, WA_SESSION_LEASE: 'local' }).leaseMode, 'local');
});

test('transportProblem: https selalu aman, http hanya loopback atau jaringan privat terdaftar', () => {
  const privateNetworks = parseAddressList('10.250.0.0/30,fd00:77::/64');

  assert.equal(transportProblem('https://203.0.113.1/x', privateNetworks), null);
  assert.equal(transportProblem('http://localhost:3901', privateNetworks), null);
  assert.equal(transportProblem('http://127.0.0.1:3901', privateNetworks), null);
  assert.equal(transportProblem('http://[::1]:3901', privateNetworks), null);
  assert.equal(transportProblem('http://10.250.0.2:3901', privateNetworks), null);
  assert.equal(transportProblem('http://[fd00:77::2]:3901', privateNetworks), null);
  assert.notEqual(transportProblem('http://10.250.0.9:3901', privateNetworks), null);
  assert.notEqual(transportProblem('http://192.168.1.5:3901', privateNetworks), null);
  assert.notEqual(transportProblem('ftp://127.0.0.1', privateNetworks), null);
  assert.notEqual(transportProblem('bukan url', privateNetworks), null);
});
