/**
 * Fmc Proxy - HTTP server & REST API.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import axios from 'axios';
import { config, sources, judges } from './config.js';
import { ProxyService } from './service.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

const service = new ProxyService();
const app = express();

app.disable('x-powered-by');
app.use(express.json({ limit: '64kb' }));

// --- CORS (permisif penuh, support semua origin/method/header) --------------
if (config.cors) {
  app.use((req, res, next) => {
    // Semua origin boleh. Tidak ada cookie/credential yang dipakai server ini,
    // jadi wildcard aman dan paling gampang dipakai dari web/app mana pun.
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS');
    // Echo header yang diminta browser (paling kompatibel), fallback ke wildcard.
    res.setHeader(
      'Access-Control-Allow-Headers',
      req.headers['access-control-request-headers'] || '*'
    );
    res.setHeader('Access-Control-Expose-Headers', '*');
    res.setHeader('Access-Control-Max-Age', '86400');
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });
}

// --- Rate limiter sederhana (per IP) ---------------------------------------
const RATE_LIMIT = { windowMs: 60_000, max: 120 };
const hits = new Map();

function rateLimit(req, res, next) {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const entry = hits.get(ip);

  if (!entry || now - entry.start > RATE_LIMIT.windowMs) {
    hits.set(ip, { start: now, count: 1 });
    return next();
  }

  entry.count++;
  if (entry.count > RATE_LIMIT.max) {
    res.setHeader('Retry-After', Math.ceil((entry.start + RATE_LIMIT.windowMs - now) / 1000));
    return res.status(429).json({ ok: false, error: 'Terlalu banyak permintaan, coba lagi sebentar.' });
  }
  return next();
}

setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of hits) {
    if (now - entry.start > RATE_LIMIT.windowMs) hits.delete(ip);
  }
}, RATE_LIMIT.windowMs).unref?.();

// --- Static web UI ----------------------------------------------------------
app.use(express.static(path.join(projectRoot, 'public'), { maxAge: '1h' }));

// --- API --------------------------------------------------------------------
app.get('/api', (req, res) => {
  res.json({
    ok: true,
    name: 'Fmc Proxy',
    description: 'Free proxy list yang sudah diverifikasi aktif & anonym.',
    endpoints: {
      health: 'GET /api/health',
      stats: 'GET /api/stats',
      proxies: 'GET /api/proxies?type=http|https|socks4|socks5&anonymity=elite|anonymous&limit=100&format=json|text',
      random: 'GET /api/proxies/random?type=http',
      sources: 'GET /api/sources',
      refresh: 'POST /api/refresh',
      cors: 'GET|POST /api/cors?url=https://contoh.com/data.json  (bantu fetch lintas-origin)',
    },
  });
});

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    status: 'up',
    refreshing: service.store.meta.isRefreshing,
    lastRefresh: service.store.meta.lastRefresh,
    total: service.store.proxies.size,
  });
});

app.get('/api/stats', (req, res) => {
  res.json({ ok: true, data: service.getState() });
});

app.get('/api/sources', (req, res) => {
  res.json({
    ok: true,
    refreshIntervalMs: config.refreshIntervalMs,
    judges,
    data: sources.map((s) => ({ name: s.name, url: s.url, protocol: s.protocol })),
    report: service.store.meta.sourceReport,
  });
});

app.get('/api/proxies/random', rateLimit, (req, res) => {
  const { items } = service.store.query({ ...parseQuery(req.query), limit: 0 });
  if (!items.length) return res.status(404).json({ ok: false, error: 'Belum ada proxy yang cocok.' });
  const picked = items[Math.floor(Math.random() * items.length)];
  res.json({ ok: true, data: formatRecord(picked, req.query) });
});

app.get('/api/proxies', rateLimit, (req, res) => {
  const query = parseQuery(req.query);
  const { total, items } = service.store.query(query);

  const meta = {
    total,
    returned: items.length,
    limit: query.limit ?? null,
    type: query.type ?? null,
    anonymity: query.anonymity ?? null,
    lastRefresh: service.store.meta.lastRefresh,
    nextRefresh: service.store.meta.nextRefresh,
    isRefreshing: service.store.meta.isRefreshing,
  };

  if (String(req.query.format).toLowerCase() === 'text') {
    const withScheme = String(req.query.scheme) === '1' || String(req.query.scheme) === 'true';
    const body = items
      .map((p) => (withScheme ? `${p.protocol}://${p.host}:${p.port}` : `${p.host}:${p.port}`))
      .join('\n');
    res.type('text/plain').send(body + (body ? '\n' : ''));
    return;
  }

  res.json({ ok: true, meta, data: items.map((p) => formatRecord(p, req.query)) });
});

app.post('/api/refresh', rateLimit, async (req, res) => {
  if (service.store.meta.isRefreshing) {
    return res.status(409).json({ ok: false, error: 'Refresh sedang berjalan.' });
  }
  const result = await service.refresh('api');
  res.json({ ok: true, result });
});

// --- CORS helper: fetch lintas-origin ---------------------------------------
// Browser sering diblokir CORS saat menembak API pihak ketiga. Endpoint ini
// membuat SERVER yang mengambil URL tujuan (bebas dari aturan CORS browser)
// lalu mengirim hasilnya balik dengan header CORS permisif di atas.
//   GET  /api/cors?url=https://contoh.com/data.json
//   POST /api/cors?url=...&method=POST  (body request diteruskan)
if (config.corsFetch) {
  app.all(
    '/api/cors',
    rateLimit,
    // Terima semua body sebagai teks (json/spesifik lain biar diteruskan apa adanya).
    express.text({ type: () => true, limit: '1mb' }),
    async (req, res) => {
      const target = String(req.query.url || '');
      if (!target) {
        return res.status(400).json({
          ok: false,
          error: 'Parameter "url" wajib diisi.',
          contoh: '/api/cors?url=https://contoh.com/data.json',
        });
      }

      let parsed;
      try {
        parsed = new URL(target);
      } catch {
        return res.status(400).json({ ok: false, error: 'URL tidak valid.' });
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return res.status(400).json({ ok: false, error: 'Hanya http:// dan https:// yang didukung.' });
      }
      if (!config.corsFetchAllowPrivate && isBlockedHost(parsed.hostname)) {
        return res.status(403).json({
          ok: false,
          error:
            'Target ke jaringan privat diblokir. Set CORS_FETCH_ALLOW_PRIVATE=true untuk mengizinkan.',
        });
      }

      const method = String(
        req.query.method || (req.method === 'POST' ? 'POST' : 'GET')
      ).toUpperCase();

      let headers = {};
      if (req.query.headers) {
        try {
          const parsedHeaders = JSON.parse(String(req.query.headers));
          if (parsedHeaders && typeof parsedHeaders === 'object') headers = parsedHeaders;
        } catch {
          return res.status(400).json({ ok: false, error: 'Parameter "headers" harus JSON objek.' });
        }
      }

      // Tanpa header eksplisit, teruskan content-type/accept dari request masuk
      // supaya body POST diteruskan dengan format yang sama (JSON tetap JSON).
      const hasHeader = (name) =>
        Object.keys(headers).some((k) => k.toLowerCase() === name);
      if (!hasHeader('content-type') && req.headers['content-type']) {
        headers['content-type'] = req.headers['content-type'];
      }
      if (!hasHeader('accept') && req.headers.accept) {
        headers.accept = req.headers.accept;
      }

      let body;
      if (method !== 'GET' && method !== 'HEAD') {
        const raw = req.body;
        if (typeof raw === 'string' && raw !== '') body = raw;
        else if (Buffer.isBuffer(raw) && raw.length) body = raw.toString('utf8');
        else if (raw && typeof raw === 'object' && !Buffer.isBuffer(raw) && Object.keys(raw).length)
          body = JSON.stringify(raw);
        // ?body= dipakai kalau tidak ada body request yang diteruskan
        if ((body === undefined || body === '') && req.query.body !== undefined)
          body = String(req.query.body);
      }

      const startedAt = Date.now();
      try {
        const upstream = await axios.request({
          url: parsed.toString(),
          method,
          headers,
          data: body,
          timeout: config.corsFetchTimeoutMs,
          maxRedirects: 5,
          maxContentLength: config.corsFetchMaxBytes,
          maxBodyLength: config.corsFetchMaxBytes,
          responseType: 'arraybuffer',
          validateStatus: () => true,
          decompress: true,
        });

        const elapsed = Date.now() - startedAt;
        const contentType = upstream.headers['content-type'] || 'application/octet-stream';
        // Header ini bisa dibaca browser karena semuanya di-expose.
        res.setHeader('X-Upstream-Status', String(upstream.status));
        res.setHeader('X-Upstream-Url', parsed.toString());
        res.setHeader('X-Elapsed-Ms', String(elapsed));

        if (String(req.query.format).toLowerCase() === 'json') {
          return res.json({
            ok: upstream.status >= 200 && upstream.status < 400,
            status: upstream.status,
            elapsedMs: elapsed,
            contentType,
            data: Buffer.from(upstream.data).toString('utf8'),
          });
        }

        res.status(upstream.status);
        res.setHeader('Content-Type', contentType);
        return res.send(Buffer.from(upstream.data));
      } catch (err) {
        return res.status(502).json({
          ok: false,
          error: `Gagal mengambil ${parsed.hostname}: ${err.code || err.message}`,
        });
      }
    }
  );
}

// 404 untuk API
app.use('/api', (req, res) => res.status(404).json({ ok: false, error: 'Endpoint tidak ditemukan.' }));

// --- util -------------------------------------------------------------------
// Blokir target ke jaringan privat supaya server tidak jadi celah SSRF.
// Bisa dimatikan lewat CORS_FETCH_ALLOW_PRIVATE=true.
const PRIVATE_HOST_RE = /^(localhost|.+\.local|.+\.internal|\[?::1\]?$|0\.0\.0\.0$|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/i;

function isBlockedHost(hostname) {
  return PRIVATE_HOST_RE.test(hostname);
}

function parseQuery(q) {
  const limit = q.limit === undefined ? 500 : Number(q.limit);
  return {
    type: q.type ? String(q.type).toLowerCase() : undefined,
    anonymity: q.anonymity ? String(q.anonymity).toLowerCase() : undefined,
    search: q.search ? String(q.search) : undefined,
    sort: q.sort ? String(q.sort) : undefined,
    limit: Number.isFinite(limit) ? limit : 500,
  };
}

function formatRecord(p, q = {}) {
  const scheme = p.protocol;
  const proxy = `${p.host}:${p.port}`;
  const format = String(q.format || '').toLowerCase();
  if (format === 'uri') return { ...p, uri: `${scheme}://${proxy}` };
  return {
    proxy,
    host: p.host,
    port: p.port,
    protocol: p.protocol,
    types: p.types,
    anonymity: p.anonymity,
    latencyMs: p.latencyMs,
    source: p.source,
    lastChecked: p.lastChecked,
  };
}

// --- start ------------------------------------------------------------------
service.start();
const server = app.listen(config.port, () => {
  console.log(`Fmc Proxy berjalan di http://localhost:${config.port}`);
  console.log(`Auto refresh tiap ${Math.round(config.refreshIntervalMs / 60000)} menit.`);
});

const shutdown = () => {
  service.stop();
  server.close(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
