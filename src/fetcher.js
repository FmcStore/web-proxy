/**
 * Fetcher: unduh seluruh sumber proxy secara paralel, lalu parse jadi kandidat.
 * Satu sumber gagal tidak menggagalkan seluruh proses.
 */

import axios from 'axios';
import { parseProxyList, proxyKey } from './parser.js';
import { userAgent } from './config.js';

async function fetchSource(source, { timeoutMs = 20000, maxPerSource = 4000 } = {}) {
  const started = Date.now();
  try {
    const res = await axios.get(source.url, {
      proxy: false,
      timeout: timeoutMs,
      responseType: 'text',
      maxRedirects: 3,
      validateStatus: () => true,
      headers: { 'User-Agent': userAgent, Accept: 'text/plain, */*' },
      transformResponse: [(d) => d],
    });

    if (res.status >= 400) {
      return { source: source.name, ok: false, error: `HTTP ${res.status}`, proxies: [] };
    }

    const proxies = parseProxyList(res.data, source.protocol, maxPerSource);
    return {
      source: source.name,
      ok: true,
      count: proxies.length,
      ms: Date.now() - started,
      proxies,
    };
  } catch (error) {
    return { source: source.name, ok: false, error: error.message, proxies: [] };
  }
}

/**
 * Ambil kandidat dari semua sumber.
 * @returns {{candidates: Array, report: Array}}
 */
export async function fetchAllSources(sources, options = {}) {
  const settled = await Promise.all(sources.map((source) => fetchSource(source, options)));

  const seen = new Set();
  const candidates = [];

  // Sumber yang punya lebih banyak proxy diprioritaskan (diproses lebih dulu)
  const ordered = [...settled].sort((a, b) => (b.count || 0) - (a.count || 0));

  for (const result of ordered) {
    for (const proxy of result.proxies) {
      const key = proxyKey(proxy);
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push({ ...proxy, source: result.source });
    }
  }

  const report = settled.map((r) => ({
    source: r.source,
    ok: r.ok,
    count: r.count || 0,
    ms: r.ms || 0,
    ...(r.error ? { error: r.error } : {}),
  }));

  return { candidates, report };
}
