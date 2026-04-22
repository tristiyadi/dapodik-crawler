# DAPO Kemendikdasmen Data Crawler

Crawler untuk mengambil data pendidikan dari [DAPO Kemendikdasmen](https://dapo.kemendikdasmen.go.id/pd) secara otomatis. Data diunduh dalam format **Excel (.xlsx)** pada setiap level hierarki wilayah.

## 📊 Hierarki Data

| Level | URL Pattern | Data |
|-------|-------------|------|
| 0 — Nasional | `/pd` | Daftar seluruh provinsi |
| 1 — Provinsi | `/pd/1/{kode}` | Daftar kabupaten/kota dalam provinsi |
| 2 — Kabupaten/Kota | `/pd/2/{kode}` | Daftar kecamatan dalam kabupaten |
| 3 — Kecamatan | `/pd/3/{kode}` | Daftar sekolah dalam kecamatan |

## 🛠️ Prasyarat

- **Node.js** v18 atau lebih baru
- **npm** (sudah termasuk dalam Node.js)

## 🚀 Instalasi

```bash
# 1. Clone / masuk ke direktori proyek
cd crawl-dapo

# 2. Install dependencies
npm install

# 3. Install browser Chromium untuk Playwright
npx playwright install chromium
```

## ▶️ Cara Menjalankan

### Crawl Seluruh Data (Nasional → Provinsi → Kabupaten → Kecamatan)

```bash
npm run crawl:nasional
# atau
node crawler-nasional.js
```

Akan mengunduh **semua level** (nasional, provinsi, kabupaten, kecamatan). Proses ini memerlukan waktu yang cukup lama karena terdapat ribuan kecamatan di seluruh Indonesia.

### Crawl Provinsi Saja (Nasional + 39 Provinsi)

```bash
npm run crawl:provinsi
# atau
node crawler-provinsi.js
```

Hanya mengunduh data level nasional dan masing-masing provinsi. Lebih cepat (~40 file Excel).

### ⚡ Crawl Parallel (10 Browser Sekaligus)

```bash
# Default: 10 browser parallel
npm run crawl:parallel

# Custom jumlah worker
npm run crawl:parallel:5     # 5 browser
npm run crawl:parallel:10    # 10 browser
node crawler-parallel.js --workers=15  # 15 browser
```

Menjalankan **beberapa browser sekaligus** menggunakan `worker_threads` sehingga proses crawling jauh lebih cepat.

#### 🏗️ Arsitektur Parallel Crawler

```
Main Thread
  │
  ├── Buka 1 browser → crawl /pd → temukan semua provinsi
  ├── Filter provinsi yang sudah selesai
  ├── Bagi provinsi ke N worker (round-robin)
  │
  ├── Worker 1 (browser sendiri) → Prov. A, B, C → rekursif ke kab/kec
  ├── Worker 2 (browser sendiri) → Prov. D, E, F → ...
  ├── Worker 3 (browser sendiri) → Prov. G, H, I → ...
  │   ...
  └── Worker N (browser sendiri) → Prov. X, Y, Z → ...
```

#### Cara Kerja:

1. **Main thread** membuka 1 browser untuk crawl halaman nasional dan menemukan semua provinsi
2. Provinsi yang belum selesai dibagi rata ke **N worker threads**
3. Setiap **worker thread** meluncurkan browser Playwright-nya sendiri (headed mode)
4. Setiap worker crawl secara **rekursif** (provinsi → kabupaten → kecamatan) untuk provinsi yang ditugaskan
5. Worker mengirim pesan `completed` ke main thread untuk **menyimpan progres** (thread-safe, tidak ada race condition pada file)
6. Main thread menunggu semua worker selesai

#### ⚠️ Kebutuhan Sistem:

| Workers | Estimasi RAM | Catatan |
|---------|-------------|--------|
| 5 | ~2.5 GB | Aman untuk kebanyakan laptop |
| 10 | ~5 GB | Disarankan RAM ≥ 8 GB |
| 15+ | ~7.5 GB+ | Disarankan RAM ≥ 16 GB |

Setiap browser instance menggunakan ~500 MB RAM. Sesuaikan `--workers` dengan kapasitas mesin Anda.

## 📁 Struktur Hasil Download

```
downloads/
├── National/                          ← Crawl nasional (crawler-nasional.js)
│   ├── National.xlsx                  ← Data seluruh provinsi
│   ├── Prov._Jawa_Barat/
│   │   ├── Prov._Jawa_Barat.xlsx      ← Data kabupaten di Jawa Barat
│   │   ├── Kab._Bogor/
│   │   │   ├── Kab._Bogor.xlsx        ← Data kecamatan di Kab. Bogor
│   │   │   ├── Kec._Cibinong/
│   │   │   │   └── Kec._Cibinong.xlsx ← Data sekolah di Kec. Cibinong
│   │   │   └── ...
│   │   └── ...
│   └── ...
│
└── provinsi/                          ← Crawl provinsi (crawler-provinsi.js)
    └── National/
        ├── National.xlsx
        ├── Prov._Jawa_Barat/
        │   └── Prov._Jawa_Barat.xlsx
        ├── Prov._DKI_Jakarta/
        │   └── Prov._DKI_Jakarta.xlsx
        └── ...
```

## ⏸️ Resume / Lanjutkan Crawling

Crawler menyimpan progres secara otomatis:

| Crawler | File Progres |
|---------|-------------|
| `crawler-nasional.js` | `progress.json` |
| `crawler-provinsi.js` | `progress-provinsi.json` |
| `crawler-parallel.js` | `progress-parallel.json` |

Jika proses terhenti (error, koneksi putus, dll), **cukup jalankan ulang perintah yang sama**. Crawler akan melewati data yang sudah selesai diunduh dan melanjutkan dari posisi terakhir.

Untuk **mengulang dari awal**, hapus file progres:
```bash
# Reset crawl nasional
del progress.json

# Reset crawl provinsi
del progress-provinsi.json

# Reset crawl parallel
del progress-parallel.json
```

## ⚙️ Konfigurasi

Konfigurasi dapat diubah di bagian atas file crawler:

| Parameter | Default | Keterangan |
|-----------|---------|------------|
| `MAX_DEPTH` | `3` (nasional) / `1` (provinsi) | Kedalaman maksimum crawl |
| `DELAY_MS` | `3000` | Jeda antar request (ms) |
| `NAV_TIMEOUT` | `120000` | Timeout navigasi halaman (ms) |
| `WAIT_TIMEOUT` | `90000` | Timeout tunggu elemen (ms) |
| `MAX_RETRIES` | `3` | Jumlah percobaan ulang per halaman |
| `MAX_WAF_RELOADS` | `15` | Jumlah reload untuk bypass WAF |

## 🔒 Catatan WAF (SafeLine)

Website DAPO dilindungi oleh **SafeLine WAF** yang menampilkan layar "Dynamic Decrypting" sebelum menampilkan konten. Crawler menangani ini dengan:

1. Memuat halaman dan mendeteksi label "Dynamic Decrypting"
2. Jika label tidak muncul, reload halaman setiap 1 detik hingga WAF terdeteksi
3. Menunggu hingga proses dekripsi selesai dan konten asli dimuat
4. Menggunakan mode **headed browser** (bukan headless) untuk keandalan bypass WAF

## 📋 Daftar File

| File | Keterangan |
|------|------------|
| `crawler-nasional.js` | Crawler seluruh level — sequential (nasional → kecamatan) |
| `crawler-provinsi.js` | Crawler provinsi saja — sequential |
| `crawler-parallel.js` | Crawler parallel — 10 browser sekaligus via `worker_threads` |
| `list_provinces.js` | Script utilitas untuk melihat daftar provinsi |
| `test_download.js` | Script tes download Excel |
| `todo.md` | Catatan tugas dan pola URL |

## 📜 Lisensi

ISC
