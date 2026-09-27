/**
 * Checker proxy.
 *
 * Tujuan: memastikan proxy BENAR-BENAR aktif DAN menyembunyikan IP asli kita.
 *
 * Alur pengecekan satu proxy:
 *   1. TCP pre-check (murah) -> kalau port tidak bisa dibuka, buang langsung.
 *   2. Request HTTPS lewat proxy (CONNECT tunnel) ke layanan echo IP.
 *      - Proxy HTTP yang sukses di sini berarti mendukung tipe "https".
 *      - Proxy SOCKS divalidasi di sini.
 *   3. Request HTTP biasa lewat proxy ke layanan echo header.
 *      - Kalau sukses berarti mendukung tipe "http".
 *      - Header respons dipakai mendeteksi kebocoran IP (X-Forwarded-For, Via, dll).
 *   4. Kalau IP yang terlihat server == IP asli kita -> proxy transparan -> DIBUANG.
 *
 * Hasil: anonymous (ada header forwarding tapi IP tetap tersembunyi) atau
 *        elite (tanpa header forwarding sama sekali).
 */

import net from 'node:net';
import axios from 'axios';
import { HttpProxyAgent } from 'http-proxy-agent';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { userAgent } from './config.js';

const IPV4_GLOBAL_RE = /(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)/;

const FORWARD_HEADER_RE =
  /^(x-forwarded-for|x-forwarded-host|forwarded|via|x-real-ip|client-ip|proxy-connection|x-proxy|http-x-forwarded-for|x-client-ip)$/i;

/** Cek apakah host:port bisa dihubungi (TCP handshake). */
export function tcpPing(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let done = false;

    const finish = (ok) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(ok);
    };

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    socket.connect(port, host);
  });
}

function firstIpv4(text) {
  if (typeof text !== 'string') return null;
  const m = text.match(IPV4_GLOBAL_RE);
  return m ? m[0] : null;
}

/** Ambil IP dari respons echo (bisa JSON objek maupun teks biasa). */
export function extractIp(data) {
  if (data == null) return null;

  if (typeof data === 'object') {
    for (const key of ['ip', 'query', 'origin', 'YourFuckingIPAddress']) {
      const value = data[key];
      if (typeof value === 'string') {
        const ip = firstIpv4(value);
        if (ip) return ip;
      }
    }
    return firstIpv4(JSON.stringify(data));
  }

  return firstIpv4(String(data));
}

/** Satu request lewat agent proxy. Tidak pernah throw. */
async function probe(agent, url, timeoutMs) {
  const started = Date.now();
  try {
    const res = await axios.get(url, {
      httpAgent: agent,
      httpsAgent: agent,
      proxy: false,
      timeout: timeoutMs,
      maxRedirects: 0,
      responseType: 'text',
      validateStatus: () => true,
      decompress: true,
      headers: { 'User-Agent': userAgent, Accept: 'application/json, text/plain, */*' },
      transformResponse: [(d) => d],
    });

    if (res.status >= 400) return { ok: false };
    return { ok: true, data: res.data, latencyMs: Date.now() - started };
  } catch {
    return { ok: false };
  }
}

/** Coba beberapa URL judge berurutan sampai ada yang berhasil. */
async function probeAny(agent, urls, timeoutMs) {
  for (const url of urls) {
    const result = await probe(agent, url, timeoutMs);
    if (result.ok && result.data) return { ...result, url };
  }
  return { ok: false };
}

/**
 * Analisa respons dari echo HTTP: cari IP yang terlihat, header forwarding,
 * dan apakah IP asli kita bocor lewat header.
 */
function analyzeEcho(data, realIp) {
  const text = typeof data === 'string' ? data : JSON.stringify(data ?? '');

  let headerNames = [];
  let headerText = '';
  if (data && typeof data === 'object' && data.headers && typeof data.headers === 'object') {
    headerNames = Object.keys(data.headers);
    headerText = JSON.stringify(data.headers);
  }

  const forwardingHeaders = headerNames.filter((name) => FORWARD_HEADER_RE.test(name.trim()));
  const leaksRealIp = Boolean(realIp) && headerText.includes(realIp);

  return { observedIp: extractIp(data), forwardingHeaders, leaksRealIp, raw: text };
}

/** Buat agent sesuai protocol proxy. */
function buildAgents(protocol, host, port) {
  if (protocol === 'socks4' || protocol === 'socks5') {
    const agent = new SocksProxyAgent(`${protocol}://${host}:${port}`);
    return { httpAgent: agent, httpsAgent: agent, socks: true };
  }
  const url = `http://${host}:${port}`;
  return {
    httpAgent: new HttpProxyAgent(url),
    httpsAgent: new HttpsProxyAgent(url),
    socks: false,
  };
}

/**
 * Cek satu kandidat proxy.
 * @param {{host:string, port:number, protocol:string}} candidate
 * @param {{config:object, judges:object, realIp:string|null}} ctx
 * @returns {Promise<object|null>} record proxy aktif, atau null kalau gagal
 */
export async function checkProxy(candidate, ctx) {
  const { host, port, protocol } = candidate;
  const { check } = ctx.config;

  const alive = await tcpPing(host, port, check.tcpTimeoutMs);
  if (!alive) return null;

  const agents = buildAgents(protocol, host, port);
  const isSocks = agents.socks;

  let supportsHttp = false;
  let supportsHttps = false;
  let latencyMs = null;
  let observedIp = null;
  let forwardingHeaders = [];
  let leakedRealIp = false;

  if (isSocks) {
    // SOCKS: satu probe HTTPS sudah cukup untuk validasi + cek IP terlihat.
    const res = await probeAny(agents.httpsAgent, ctx.judges.ip, check.judgeTimeoutMs);
    if (!res.ok) return null;

    observedIp = extractIp(res.data);
    latencyMs = res.latencyMs;
    if (!observedIp) return null; // tidak bisa dipastikan -> buang
    forwardingHeaders = [];
  } else {
    // Proxy HTTP: cek dukungan CONNECT (https) lewat judge HTTPS.
    const ipRes = await probeAny(agents.httpsAgent, ctx.judges.ip, check.judgeTimeoutMs);
    if (ipRes.ok) {
      supportsHttps = true;
      observedIp = extractIp(ipRes.data);
      latencyMs = ipRes.latencyMs;
    }

    // Cek dukungan HTTP biasa + analisa header yang bocor.
    const echoRes = await probeAny(agents.httpAgent, ctx.judges.echo, check.judgeTimeoutMs);
    if (echoRes.ok) {
      supportsHttp = true;
      if (latencyMs === null || echoRes.latencyMs < latencyMs) latencyMs = echoRes.latencyMs;

      const analysis = analyzeEcho(echoRes.data, ctx.realIp);
      forwardingHeaders = analysis.forwardingHeaders;
      leakedRealIp = analysis.leaksRealIp;
      if (!observedIp) observedIp = analysis.observedIp;
    }

    if (!supportsHttp && !supportsHttps) return null;
  }

  // Pastikan IP asli kita benar-benar tersembunyi.
  const transparent = Boolean(ctx.realIp && observedIp && observedIp === ctx.realIp);
  if (ctx.config.rejectTransparent && (transparent || leakedRealIp)) return null;

  let anonymity = 'anonymous';
  if (ctx.realIp && !observedIp) anonymity = 'unknown';
  else if (forwardingHeaders.length === 0 && !leakedRealIp) anonymity = 'elite';

  const types = [];
  if (isSocks) types.push(protocol);
  else {
    if (supportsHttp) types.push('http');
    if (supportsHttps) types.push('https');
  }

  return {
    host,
    port,
    protocol,
    types,
    anonymity,
    latencyMs: latencyMs ?? null,
    observedIp: observedIp ?? null,
    forwardingHeaders,
    lastChecked: new Date().toISOString(),
  };
}

/** Jalankan worker dengan batas konkurensi. */
export async function runPool(items, worker, concurrency) {
  const results = new Array(items.length).fill(null);
  let cursor = 0;

  const size = Math.max(1, Math.min(concurrency, items.length || 1));
  const runners = Array.from({ length: size }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      try {
        results[index] = await worker(items[index], index);
      } catch {
        results[index] = null;
      }
    }
  });

  await Promise.all(runners);
  return results;
}

/** Ambil IP publik kita sendiri (tanpa proxy) untuk pembanding. */
export async function detectRealIp(urls, timeoutMs) {
  for (const url of urls) {
    try {
      const res = await axios.get(url, {
        proxy: false,
        timeout: timeoutMs,
        responseType: 'text',
        validateStatus: () => true,
        headers: { 'User-Agent': userAgent },
        transformResponse: [(d) => d],
      });
      const ip = extractIp(res.data);
      if (ip) return ip;
    } catch {
      // coba URL berikutnya
    }
  }
  return null;
}
