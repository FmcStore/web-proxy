/**
 * Store: penyimpanan proxy aktif di memori + persist ke disk (JSON).
 *
 * Hasil pengecekan ditulis langsung ke store supaya UI bisa menampilkan
 * progres selama proses scan berjalan.
 */

import fs from 'node:fs';
import path from 'node:path';
import { proxyKey } from './parser.js';

export class ProxyStore {
  constructor(dataFile) {
    this.dataFile = dataFile;
    /** @type {Map<string, object>} */
    this.proxies = new Map();
    this.meta = {
      lastRefresh: null,
      lastRefreshMs: null,
      nextRefresh: null,
      cycleStartedAt: null,
      isRefreshing: false,
      realIp: null,
      progress: { checked: 0, total: 0, alive: 0 },
      stats: null,
      sourceReport: [],
    };
  }

  /** Muat hasil terakhir dari disk (kalau ada) supaya restart tidak kosong. */
  load() {
    try {
      if (!this.dataFile || !fs.existsSync(this.dataFile)) return false;
      const raw = JSON.parse(fs.readFileSync(this.dataFile, 'utf8'));
      const list = Array.isArray(raw) ? raw : raw.proxies || [];

      for (const record of list) {
        const key = proxyKey(record);
        this.proxies.set(key, record);
      }

      if (raw && !Array.isArray(raw) && raw.meta) {
        this.meta = { ...this.meta, ...raw.meta, isRefreshing: false, progress: this.meta.progress };
      }
      return true;
    } catch {
      return false;
    }
  }

  save() {
    try {
      if (!this.dataFile) return;
      fs.mkdirSync(path.dirname(this.dataFile), { recursive: true });
      const payload = {
        meta: {
          ...this.meta,
          isRefreshing: false,
          progress: { ...this.meta.progress, total: this.proxies.size, checked: this.proxies.size },
        },
        proxies: [...this.proxies.values()],
      };
      fs.writeFileSync(this.dataFile, JSON.stringify(payload), 'utf8');
    } catch {
      // persistensi bersifat opsional, jangan sampai mematikan service
    }
  }

  upsert(record) {
    const key = proxyKey(record);
    const existing = this.proxies.get(key);
    this.proxies.set(key, {
      ...existing,
      ...record,
      source: record.source ?? existing?.source,
      firstSeen: existing?.firstSeen ?? record.lastChecked,
    });
  }

  /** Hapus proxy yang tidak lolos di siklus terakhir (sudah mati). */
  pruneOlderThan(isoTime) {
    let removed = 0;
    for (const [key, record] of this.proxies) {
      if (!record.lastChecked || record.lastChecked < isoTime) {
        this.proxies.delete(key);
        removed++;
      }
    }
    return removed;
  }

  all() {
    return [...this.proxies.values()];
  }

  /** Daftar proxy dengan filter + sorting + limit. */
  query({ type, anonymity, search, limit, sort } = {}) {
    let list = this.all();

    if (type) {
      const wanted = String(type).toLowerCase();
      list = list.filter((p) =>
        wanted === 'socks' ? p.types.some((t) => t.startsWith('socks')) : p.types.includes(wanted),
      );
    }

    if (anonymity) {
      const wanted = String(anonymity).toLowerCase();
      list = list.filter((p) => p.anonymity === wanted);
    }

    if (search) {
      const needle = String(search).toLowerCase();
      list = list.filter((p) => `${p.host}:${p.port}`.includes(needle));
    }

    const sorted = [...list].sort((a, b) => {
      if (sort === 'latency-desc') return (b.latencyMs ?? 1e9) - (a.latencyMs ?? 1e9);
      if (sort === 'recent') return (b.lastChecked || '').localeCompare(a.lastChecked || '');
      if (sort === 'random') return Math.random() - 0.5;
      return (a.latencyMs ?? 1e9) - (b.latencyMs ?? 1e9); // default: tercepat
    });

    const total = sorted.length;
    const max = Number.isFinite(limit) && limit > 0 ? limit : total;
    return { total, items: sorted.slice(0, max) };
  }

  /** Ringkasan untuk dashboard. */
  summary() {
    const byType = { http: 0, https: 0, socks4: 0, socks5: 0 };
    const byProtocol = { http: 0, socks4: 0, socks5: 0 };
    const byAnonymity = { elite: 0, anonymous: 0, unknown: 0 };
    let latencySum = 0;
    let latencyCount = 0;

    for (const p of this.proxies.values()) {
      for (const t of p.types || []) byType[t] = (byType[t] || 0) + 1;
      byProtocol[p.protocol] = (byProtocol[p.protocol] || 0) + 1;
      byAnonymity[p.anonymity] = (byAnonymity[p.anonymity] || 0) + 1;
      if (Number.isFinite(p.latencyMs)) {
        latencySum += p.latencyMs;
        latencyCount++;
      }
    }

    return {
      total: this.proxies.size,
      byType,
      byProtocol,
      byAnonymity,
      avgLatencyMs: latencyCount ? Math.round(latencySum / latencyCount) : null,
      oldestCheck: this.oldestCheck(),
    };
  }

  oldestCheck() {
    let oldest = null;
    for (const p of this.proxies.values()) {
      if (!p.lastChecked) continue;
      if (!oldest || p.lastChecked < oldest) oldest = p.lastChecked;
    }
    return oldest;
  }

  clear() {
    this.proxies.clear();
  }
}
