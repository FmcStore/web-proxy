/**
 * Fmc Proxy - HTTP server & REST API.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { config, sources, judges } from './config.js';
import { ProxyService } from './service.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

const service = new ProxyService();
const app = express();

app.disable('x-powered-by');
app.use(express.json({ limit: '64kb' }));

// --- CORS -------------------------------------------------------------------
if (config.cors) {
  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
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

// 404 untuk API
app.use('/api', (req, res) => res.status(404).json({ ok: false, error: 'Endpoint tidak ditemukan.' }));

// --- util -------------------------------------------------------------------
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
