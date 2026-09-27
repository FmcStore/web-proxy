/**
 * Service: orkestrasi siklus refresh.
 *
 * Satu siklus = fetch semua sumber -> kumpulkan kandidat unik -> cek semuanya
 * -> simpan hanya yang aktif & menyembunyikan IP asli -> buang sisanya.
 * Dijalankan otomatis setiap `refreshIntervalMs` (default 10 menit).
 */

import { config, sources, judges } from './config.js';
import { fetchAllSources } from './fetcher.js';
import { checkProxy, runPool, detectRealIp } from './checker.js';
import { ProxyStore } from './store.js';

export class ProxyService {
  constructor() {
    this.store = new ProxyStore(config.dataFile);
    this.realIp = null;
    this.timer = null;
    this.startedAt = new Date().toISOString();
  }

  getState() {
    return {
      ...this.store.meta,
      uptimeMs: Date.now() - new Date(this.startedAt).getTime(),
      summary: this.store.summary(),
    };
  }

  /** Jalankan satu siklus lengkap. Tidak akan tumpang tindih. */
  async refresh(reason = 'scheduled') {
    if (this.store.meta.isRefreshing) {
      return { skipped: true, reason: 'refresh sedang berjalan' };
    }

    const cycleStart = new Date().toISOString();
    const startedAt = Date.now();
    this.store.meta.isRefreshing = true;
    this.store.meta.cycleStartedAt = cycleStart;
    this.store.meta.progress = { checked: 0, total: 0, alive: 0 };

    console.log(`[refresh] mulai (${reason})`);

    try {
      // 1. IP publik kita sendiri sebagai pembanding deteksi transparan.
      const detected = await detectRealIp(judges.direct, 6000);
      if (detected) this.realIp = detected;
      this.store.meta.realIp = this.realIp;

      // 2. Ambil semua sumber.
      const { candidates: fetched, report } = await fetchAllSources(sources, {
        maxPerSource: config.maxPerSource,
      });
      const candidates = fetched.slice(0, config.maxCandidates);

      this.store.meta.sourceReport = report;
      this.store.meta.progress.total = candidates.length;

      console.log(
        `[refresh] ${candidates.length} kandidat unik dari ${report.filter((r) => r.ok).length}/${report.length} sumber`,
      );

      // 3. Cek satu per satu, simpan yang hidup secara langsung (progress live).
      const ctx = { config, judges, realIp: this.realIp };
      let alive = 0;

      await runPool(
        candidates,
        async (candidate) => {
          const record = await checkProxy(candidate, ctx);
          this.store.meta.progress.checked++;

          if (record) {
            record.source = candidate.source;
            this.store.upsert(record);
            alive++;
            this.store.meta.progress.alive = alive;
          }
          return null;
        },
        config.check.concurrency,
      );

      // 4. Buang proxy yang tidak lolos di siklus ini (sudah mati).
      //    Kalau tidak ada kandidat sama sekali (mis. semua sumber sedang down),
      //    jangan hapus apa pun supaya daftar lama tidak ikut hilang.
      const removed = candidates.length > 0 ? this.store.pruneOlderThan(cycleStart) : 0;

      this.store.meta.lastRefresh = new Date().toISOString();
      this.store.meta.lastRefreshMs = Date.now() - startedAt;
      this.store.meta.stats = {
        candidates: candidates.length,
        alive,
        removed,
        byType: this.store.summary().byType,
      };

      console.log(
        `[refresh] selesai: ${alive} aktif, ${removed} dibuang, ${(this.store.meta.lastRefreshMs / 1000).toFixed(0)}s`,
      );

      this.store.save();
      return {
        ok: true,
        candidates: candidates.length,
        alive,
        removed,
        durationMs: this.store.meta.lastRefreshMs,
      };
    } catch (error) {
      console.error('[refresh] gagal:', error.message);
      return { ok: false, error: error.message };
    } finally {
      this.store.meta.isRefreshing = false;
      this.scheduleNext();
    }
  }

  scheduleNext() {
    this.store.meta.nextRefresh = new Date(Date.now() + config.refreshIntervalMs).toISOString();
  }

  /** Nyalakan scheduler + opsional jalankan siklus pertama saat start. */
  start() {
    const loaded = this.store.load();
    if (loaded && this.store.proxies.size) {
      console.log(`[store] memuat ${this.store.proxies.size} proxy dari ${config.dataFile}`);
    }

    this.scheduleNext();
    this.timer = setInterval(() => {
      const reason = 'scheduled';
      this.scheduleNext();
      this.refresh(reason);
    }, config.refreshIntervalMs);
    this.timer.unref?.();

    if (config.refreshOnStart && this.store.proxies.size === 0) {
      // beri jeda kecil supaya server siap dulu
      setTimeout(() => this.refresh('startup'), 500);
    }
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
