# 🛡️ Fmc Proxy

Web + API penyedia **free proxy yang sudah diverifikasi aktif** untuk tipe **HTTP, HTTPS, dan SOCKS5 (plus SOCKS4)**.

Proxy diambil otomatis dari beberapa sumber publik, **dicek satu per satu**, dan hanya yang **benar-benar hidup sekaligus menyembunyikan IP asli kita** (non-transparent) yang ditampilkan.

---

## ✨ Fitur

- **Auto fetch + auto check** setiap 10 menit (bisa diubah).
- **Verifikasi nyata**: bukan cuma "port terbuka", tapi request betulan lewat proxy.
- **Deteksi IP bocor**: proxy yang masih memperlihatkan IP asli kita (transparent) otomatis dibuang.
- **Klasifikasi anonimitas**: `elite` (tanpa header forwarding) dan `anonymous`.
- **Deteksi tipe asli**: proxy HTTP yang mendukung CONNECT ditandai sebagai `https`.
- **Web UI**: filter tipe, filter anonimitas, pencarian, sorting, copy, dan unduh `.txt`.
- **Kolom “Umur Cek”**: menampilkan berapa lama sejak tiap proxy terakhir diverifikasi, diperbarui tiap detik.
- **REST API**: JSON / plain text / random proxy.
- **Docker ready**: ada `Dockerfile` + `docker-compose.yml`.
- **Persisten**: hasil pengecekan disimpan di `data/proxies.json`, jadi server restart tidak kosong.

---

## 🔄 Alur Kerja

```
        ┌─────────────────────────────────────────────────────────────┐
        │  1. FETCH  (setiap 10 menit, semua sumber paralel)           │
        │     raw GitHub / API  ──►  parse  ──►  daftar kandidat unik   │
        └───────────────────────────────┬─────────────────────────────┘
                                        ▼
        ┌─────────────────────────────────────────────────────────────┐
        │  2. TCP PRE-CHECK  (murah, cepat)                            │
        │     buka socket ke host:port, timeout 2.5s                   │
        │     gagal ──► dibuang                                        │
        └───────────────────────────────┬─────────────────────────────┘
                                        ▼
        ┌─────────────────────────────────────────────────────────────┐
        │  3. REAL REQUEST LEWAT PROXY                                 │
        │     a) HTTPS (CONNECT tunnel) ke layanan echo IP             │
        │        ──► sukses = proxy valid + mendukung tipe "https"     │
        │     b) HTTP biasa ke layanan echo header                     │
        │        ──► sukses = mendukung tipe "http"                    │
        │        ──► header diperiksa: X-Forwarded-For, Via, dll        │
        └───────────────────────────────┬─────────────────────────────┘
                                        ▼
        ┌─────────────────────────────────────────────────────────────┐
        │  4. VERDICT                                                  │
        │  IP terlihat == IP asli kita  ──► TRANSPARAN  ──► BUANG       │
        │  header memuat IP asli kita   ──► BOCOR       ──► BUANG       │
        │  aman                         ──► SIMPAN (elite/anonymous)   │
        └───────────────────────────────┬─────────────────────────────┘
                                        ▼
        ┌─────────────────────────────────────────────────────────────┐
        │  5. PRUNE  proxy yang tidak lolos di siklus ini dihapus       │
        │  6. SERVE  Web UI + REST API                                 │
        └─────────────────────────────────────────────────────────────┘
```

### Kenapa dipisah HTTPS dan HTTP saat pengecekan?

- Lewat **HTTPS/CONNECT**, proxy hanya meneruskan tunnel terenkripsi sehingga **tidak mungkin menyisipkan header bocor**. Ini cara paling jujur untuk melihat **IP mana yang terlihat dari luar**.
- Lewat **HTTP biasa**, proxy bisa menambahkan header seperti `X-Forwarded-For`. Dari sini kita tahu apakah IP asli bocor dan apakah proxy termasuk `elite` atau `anonymous`.

### Arti anonimitas

| Label       | Arti                                                                 |
| ----------- | -------------------------------------------------------------------- |
| `elite`     | Tidak menambahkan header forwarding apa pun, IP asli tidak terlihat.  |
| `anonymous` | Ada header forwarding, tapi IP asli kita tetap tidak terlihat.       |
| `unknown`   | IP luar tidak berhasil dibaca (jarang; tetap non-transparent).       |

Proxy **transparent** (IP asli terlihat) dan proxy yang **membocorkan IP lewat header** tidak akan pernah masuk daftar.

---

## 🚀 Menjalankan

### Lokal (Node.js ≥ 18)

```bash
npm install
npm start
```

Buka `http://localhost:3000`.

Cek ulang satu kali lalu keluar (cocok untuk cron):

```bash
npm run refresh
```

### Docker

```bash
docker build -t fmc-proxy .
docker run -d --name fmc-proxy -p 3000:3000 -v "$PWD/data:/app/data" fmc-proxy
```

### Docker Compose

```bash
docker compose up -d --build
```

Buka `http://localhost:3000`.

### Railway

Repo ini sudah menyertakan `railway.toml` (Config as Code), jadi tidak perlu setting apapun di dashboard.

**Cara deploy:**

1. Push repo ini ke GitHub
2. Buka [railway.com](https://railway.com) → **New Project** → **Deploy from GitHub repo** → pilih repo ini
3. (Opsional) Settings → Networking → **Generate Domain** untuk mendapat URL publik

Yang otomatis terpasang dari `railway.toml`:

| Setting | Nilai |
| --- | --- |
| Builder | `DOCKERFILE` (pakai `Dockerfile` di root) |
| Start command | `node src/server.js` |
| Healthcheck | `GET /api/health`, timeout 120 detik |
| Restart policy | `ALWAYS`, maks 10 kali retry |
| Watch patterns | hanya rebuild kalau `src/`, `public/`, `package.json`, atau `Dockerfile` berubah |

Tidak perlu set `PORT` — Railway menyuntikkannya otomatis dan server sudah membacanya.

Data pengecekan (`data/proxies.json`) hidup di filesystem container, jadi hilang saat re-deploy. Kalau mau persisten, mount volume di Railway (Settings → Volumes, mount ke `/app/data`).

---

## 🔌 API

> Dokumentasi ini juga tersedia **langsung di website**, di bagian bawah halaman — lengkap dengan tabel endpoint, tabel parameter, contoh cURL/JS/Python, dan panel **“Coba Langsung”** yang bisa menembak API dari browser dan menampilkan responsnya.

| Endpoint | Keterangan |
| --- | --- |
| `GET /api/proxies` | List proxy (JSON) |
| `GET /api/proxies?format=text` | Teks `ip:port` |
| `GET /api/proxies?format=text&scheme=1` | Teks `protocol://ip:port` |
| `GET /api/proxies/random` | Satu proxy acak |
| `GET /api/stats` | Statistik + status refresh |
| `GET /api/sources` | Daftar sumber + hasil fetch terakhir |
| `GET /api/health` | Health check |
| `POST /api/refresh` | Paksa cek ulang sekarang |

### Parameter query `/api/proxies`

| Parameter | Nilai | Default |
| --- | --- | --- |
| `type` | `http`, `https`, `socks5`, `socks4` | semua |
| `anonymity` | `elite`, `anonymous` | semua |
| `search` | sebagian IP | – |
| `sort` | `latency`, `recent`, `random` | `latency` |
| `limit` | angka | `500` |
| `format` | `json`, `text`, `uri` | `json` |
| `scheme` | `1` untuk `protocol://ip:port` di format teks | off |

### Contoh

```bash
# 50 proxy HTTP tercepat
curl "http://localhost:3000/api/proxies?type=http&limit=50"

# daftar teks siap pakai
curl "http://localhost:3000/api/proxies?type=socks5&format=text"

# satu proxy acak
curl "http://localhost:3000/api/proxies/random?type=https"
```

Contoh respons JSON:

```json
{
  "ok": true,
  "meta": { "total": 812, "returned": 2, "type": "http", "lastRefresh": "2026-09-26T02:30:07.146Z" },
  "data": [
    {
      "proxy": "172.234.38.154:3128",
      "host": "172.234.38.154",
      "port": 3128,
      "protocol": "http",
      "types": ["http", "https"],
      "anonymity": "elite",
      "latencyMs": 39,
      "source": "proxyscrape-http",
      "lastChecked": "2026-09-26T02:29:45.726Z"
    }
  ]
}
```

---

## ⚙️ Konfigurasi (env)

| Variabel | Default | Keterangan |
| --- | --- | --- |
| `PORT` | `3000` | Port web server |
| `REFRESH_INTERVAL_MS` | `600000` | Interval auto refresh (10 menit) |
| `REFRESH_ON_START` | `true` | Jalankan pengecekan saat start (kalau daftar masih kosong) |
| `MAX_PER_SOURCE` | `2000` | Batas proxy diambil per sumber |
| `MAX_CANDIDATES` | `25000` | Batas total kandidat per siklus |
| `CHECK_CONCURRENCY` | `250` | Jumlah pengecekan paralel |
| `TCP_TIMEOUT_MS` | `2500` | Timeout pre-check TCP |
| `JUDGE_TIMEOUT_MS` | `7000` | Timeout request lewat proxy |
| `REJECT_TRANSPARENT` | `true` | Buang proxy yang membocorkan IP asli |
| `DATA_FILE` | `data/proxies.json` | Lokasi file hasil |
| `CORS` | `true` | Aktifkan CORS di API |

---

## 📚 Sumber Proxy

Semua daftar di-fetch ulang tiap siklus, lalu tetap **diverifikasi ulang** (tidak dipercaya begitu saja).

| Nama | Tipe default |
| --- | --- |
| `vpslab-all-anonymous` | http |
| `vpslab-http-anonymous` | http |
| `iplocate-all-proxies` | http (ada skema di tiap baris) |
| `proxmint-elite` | http |
| `monosans-http` | http |
| `iplocate-http` | http |
| `proxyscrape-http` | http |
| `proxifly-http` | http |
| `monosans-socks5` / `monosans-socks4` | socks5 / socks4 |
| `iplocate-socks5` / `iplocate-socks4` | socks5 / socks4 |
| `proxifly-socks5` / `proxifly-socks4` | socks5 / socks4 |

> Tambahan socks diambil dari repo yang sama supaya pilihan SOCKS benar-benar terisi.
> Mau ubah? Semua sumber ada di **`src/config.js`** pada array `sources`.

Menambah sumber baru:

```js
{
  name: 'sumber-baru',
  url: 'https://contoh.com/proxy.txt',
  protocol: 'http', // buat kalau baris cuma `ip:port`
}
```

Kalau baris sudah berisi skema (`socks5://ip:port`, `http://ip:port`), bagian `protocol` akan otomatis ter-override.

---

## 🗂️ Struktur Proyek

```
.
├── src/
│   ├── config.js       # konfigurasi + daftar sumber + endpoint judge
│   ├── parser.js       # parser daftar proxy mentah
│   ├── fetcher.js      # unduh + parse semua sumber
│   ├── checker.js      # TCP pre-check, request lewat proxy, deteksi anonimitas
│   ├── store.js        # penyimpanan di memori + persist JSON
│   ├── service.js      # orkestrasi siklus refresh + scheduler
│   ├── server.js       # Express server + REST API
│   └── cli-refresh.js  # jalankan 1 siklus lalu keluar
├── public/             # web UI (HTML/CSS/JS, tanpa build step)
├── data/               # hasil pengecekan (dibuat otomatis)
├── Dockerfile
├── docker-compose.yml
└── README.md
```

---

## ⚠️ Catatan

- Free proxy itu **tidak stabil** dan bisa mati kapan saja. Angka "aktif" adalah hasil pengecekan terakhir.
- Jangan pakai proxy publik untuk data sensitif (login, perbankan, dsb).
- Beberapa proxy mungkin berada di jaringan yang memantau trafik. Gunakan dengan risiko sendiri.
- Semua data yang ditampilkan **hanya** proxy yang lolos verifikasi "menyembunyikan IP asli". Kalau daftar kosong, tunggu siklus berikutnya atau tekan **Cek Ulang Sekarang**.
