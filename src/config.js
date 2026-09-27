/**
 * Fmc Proxy - konfigurasi global & daftar sumber proxy.
 *
 * Semua sumber di-fetch ulang setiap REFRESH_INTERVAL_MS, lalu SETIAP kandidat
 * proxy dicek satu per satu. Hanya proxy yang BENAR-BENAR aktif + menyembunyikan
 * IP asli kita (non-transparent) yang disimpan dan ditampilkan.
 */

const num = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

const bool = (value, fallback) => {
  if (value === undefined || value === '') return fallback;
  return !['0', 'false', 'no', 'off'].includes(String(value).toLowerCase());
};

export const config = {
  // Port HTTP server
  port: num(process.env.PORT, 3000),

  // Interval auto refresh (default 10 menit)
  refreshIntervalMs: num(process.env.REFRESH_INTERVAL_MS, 10 * 60 * 1000),

  // Jalankan pengecekan pertama saat server start
  refreshOnStart: bool(process.env.REFRESH_ON_START, true),

  // Berapa proxy tiap sumber yang diambil (list bisa sangat besar)
  maxPerSource: num(process.env.MAX_PER_SOURCE, 2000),
  // Batas total kandidat per siklus (pengaman waktu scan)
  maxCandidates: num(process.env.MAX_CANDIDATES, 25000),

  check: {
    // Jumlah proxy yang dicek secara paralel
    concurrency: num(process.env.CHECK_CONCURRENCY, 250),
    // Timeout koneksi TCP awal (pre-check murah sebelum request HTTP)
    tcpTimeoutMs: num(process.env.TCP_TIMEOUT_MS, 2500),
    // Timeout request HTTP lewat proxy
    judgeTimeoutMs: num(process.env.JUDGE_TIMEOUT_MS, 7000),
  },

  // Kalau true: proxy yang membocorkan IP asli kita (transparent) dibuang.
  rejectTransparent: bool(process.env.REJECT_TRANSPARENT, true),

  // Simpan hasil ke disk supaya restart berikutnya langsung terisi
  dataFile: process.env.DATA_FILE || 'data/proxies.json',

  // Aktifkan CORS untuk API (biar gampang dikonsumsi app lain)
  cors: bool(process.env.CORS, true),
};

/**
 * Daftar sumber proxy.
 *
 * protocol = protocol default kalau baris tidak menyertakan skema.
 * Banyak list hanya berisi `ip:port` sehingga perlu default ini.
 *
 * Sumber bertanda `builtin: false` adalah tambahan yang diambil dari repo yang
 * sama agar pilihan socks4/socks5 benar-benar ada isinya. Hapus kalau tidak perlu.
 */
export const sources = [
  // ---- Sumber dari user -------------------------------------------------
  {
    name: 'vpslab-all-anonymous',
    url: 'https://raw.githubusercontent.com/VPSLabCloud/VPSLab-Free-Proxy-List/refs/heads/main/all_anonymous.txt',
    protocol: 'http',
  },
  {
    name: 'vpslab-http-anonymous',
    url: 'https://raw.githubusercontent.com/VPSLabCloud/VPSLab-Free-Proxy-List/refs/heads/main/http_anonymous.txt',
    protocol: 'http',
  },
  {
    name: 'iplocate-all-proxies',
    url: 'https://raw.githubusercontent.com/iplocate/free-proxy-list/refs/heads/main/all-proxies.txt',
    protocol: 'http',
  },
  {
    name: 'proxmint-elite',
    url: 'https://raw.githubusercontent.com/proxmint/free-proxy-list/refs/heads/main/proxies/elite.txt',
    protocol: 'http',
  },
  {
    name: 'monosans-http',
    url: 'https://raw.githubusercontent.com/monosans/proxy-list/refs/heads/main/proxies/http.txt',
    protocol: 'http',
  },
  {
    name: 'iplocate-http',
    url: 'https://raw.githubusercontent.com/iplocate/free-proxy-list/refs/heads/main/protocols/http.txt',
    protocol: 'http',
  },
  {
    name: 'proxyscrape-http',
    url: 'https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&proxy_format=protocolipport&format=text&protocol=http&timeout=5000',
    protocol: 'http',
  },
  {
    name: 'proxifly-http',
    url: 'https://raw.githubusercontent.com/proxifly/free-proxy-list/refs/heads/main/proxies/protocols/http/data.txt',
    protocol: 'http',
  },

  // ---- Tambahan dari repo yang sama (untuk tipe socks) ------------------
  {
    name: 'monosans-socks5',
    url: 'https://raw.githubusercontent.com/monosans/proxy-list/refs/heads/main/proxies/socks5.txt',
    protocol: 'socks5',
    builtin: false,
  },
  {
    name: 'monosans-socks4',
    url: 'https://raw.githubusercontent.com/monosans/proxy-list/refs/heads/main/proxies/socks4.txt',
    protocol: 'socks4',
    builtin: false,
  },
  {
    name: 'iplocate-socks5',
    url: 'https://raw.githubusercontent.com/iplocate/free-proxy-list/refs/heads/main/protocols/socks5.txt',
    protocol: 'socks5',
    builtin: false,
  },
  {
    name: 'iplocate-socks4',
    url: 'https://raw.githubusercontent.com/iplocate/free-proxy-list/refs/heads/main/protocols/socks4.txt',
    protocol: 'socks4',
    builtin: false,
  },
  {
    name: 'proxifly-socks5',
    url: 'https://raw.githubusercontent.com/proxifly/free-proxy-list/refs/heads/main/proxies/protocols/socks5/data.txt',
    protocol: 'socks5',
    builtin: false,
  },
  {
    name: 'proxifly-socks4',
    url: 'https://raw.githubusercontent.com/proxifly/free-proxy-list/refs/heads/main/proxies/protocols/socks4/data.txt',
    protocol: 'socks4',
    builtin: false,
  },
];

/**
 * Endpoint "hakim" untuk mengukur apakah proxy menyembunyikan IP kita.
 *
 * IP_JUDGES  : lewat HTTPS (CONNECT tunnel) -> hanya dipakai untuk melihat IP
 *              yang terlihat dari luar, tunnel TLS tidak bisa dimodifikasi.
 * ECHO_JUDGES: lewat HTTP biasa -> dipakai untuk memeriksa header bocor
 *              (X-Forwarded-For, Via, dst) yang membocorkan IP asli.
 */
export const judges = {
  ip: [
    'https://api.ipify.org?format=json',
    'https://ipinfo.io/json',
    'https://ifconfig.me/all.json',
  ],
  echo: [
    'http://httpbin.org/get?show_env=1',
    'http://ip-api.com/json/?fields=query',
  ],
  // Dipakai untuk tau IP publik kita sendiri (tanpa proxy)
  direct: [
    'https://api.ipify.org?format=json',
    'https://ipinfo.io/ip',
    'https://ifconfig.me/ip',
  ],
};

export const userAgent =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
