# LPG Agen Helper Scheduler

> **⚠️ Disclaimer — Educational Purpose Only**
>
> Script ini dibuat **semata-mata untuk tujuan pembelajaran** dan pemahaman alur API.
> Dilarang keras menjual, mendistribusikan, atau menggunakannya untuk kepentingan
> komersial / penyalahgunaan sistem.
>
> **Author:** @ChocoPie02 — [github.com/ChocoPie02](https://github.com/ChocoPie02)

---

## Deskripsi

CLI scheduler Node.js untuk membantu agen LPG 3 Kg yang menggunakan platform
**MyPertamina** (`api-map.my-pertamina.id`) dalam mendistribusikan stok secara
terjadwal melalui API resmi.

Script mensimulasikan alur yang biasa dilakukan secara manual oleh agen:

1. Login dengan verifikasi reCAPTCHA v3 Enterprise
2. Fetch profil merchant & stok produk
3. Cek keberadaan customer dari daftar NIK
4. Verifikasi detail customer
5. Cek sisa kuota (Rumah Tangga & Usaha Mikro)
6. Submit transaksi penjualan

---

## Fitur Utama

| Fitur | Keterangan |
|-------|-----------|
| **Habiskan Kuota** | Keluarkan semua stok yang tersedia secepat mungkin |
| **Mode Harian** | Bagi stok ke sejumlah hari dan sebar transaksi di jam kerja |
| **Mode Standby** | Pantau `stockDate`; otomatis mulai distribusi jika stok baru masuk |
| **Token auto-renew** | Login ulang otomatis saat bearer token kadaluarsa |
| **Provider captcha** | Pilih 2captcha atau anti-captcha via `.env` (tanya sekali, simpan permanen) |
| **State persistence** | Resume otomatis dari `state.json` setelah restart |
| **CSV extensible** | `data.csv` cukup kolom `nik`; siap diperluas untuk fitur registrasi NIK |
| **Proxy support** | HTTP/HTTPS/SOCKS4/SOCKS5 dari `proxy.txt` |

---

## Struktur File

```
LPG-Agen-Helper/
├── main.js                  ← Entrypoint
├── package.json
├── .env                     ← Konfigurasi (wajib, tidak di-commit)
├── .env.example             ← Template konfigurasi
├── data.csv                 ← Daftar NIK 16-digit
├── proxy.txt                ← Proxy opsional (1 per baris)
├── state.json               ← State runtime (auto-generated)
├── services/
│   ├── app.js               ← Orchestrator & 3 mode scheduler
│   ├── client.js            ← HTTP client LPG API
│   ├── captcha.js           ← Wrapper 2captcha / anti-captcha
│   └── state.js             ← Baca/tulis state lokal
└── utils/
    ├── banner.js
    ├── logger.js
    └── helper.js            ← Utilitas: delay, CSV, jadwal, proxy, env, NIK
```

---

## Persyaratan

- **Node.js** ≥ 18
- Akun agen aktif di MyPertamina
- API key dari [2captcha.com](https://2captcha.com) **atau** [anti-captcha.com](https://anti-captcha.com)

---

## Instalasi

```bash
git clone https://github.com/ChocoPie02/lpg-agen-helper.git
cd lpg-agen-helper
npm install
cp .env.example .env
```

Edit `.env` dengan kredensial Anda (atau biarkan kosong — aplikasi akan meminta
input interaktif saat pertama kali dijalankan dan menyimpannya otomatis).

---

## Konfigurasi `.env`

| Variabel | Wajib | Default | Keterangan |
|----------|-------|---------|-----------|
| `LOGIN_USERNAME` | ✅ | — | Email akun agen |
| `LOGIN_PIN` | ✅ | — | PIN 6 digit |
| `CAPTCHA_PROVIDER` | ✅ | — | `2captcha` atau `anti-captcha` |
| `CAPTCHA_2CAPTCHA_KEY` | ✅* | — | API key 2captcha |
| `CAPTCHA_ANTI_KEY` | ✅* | — | API key anti-captcha |
| `WORK_START` | | `07:00` | Jam mulai transaksi |
| `WORK_END` | | `18:00` | Jam berhenti transaksi |
| `TIMEZONE` | | `Asia/Jakarta` | Zona waktu |
| `STANDBY_POLL_MINUTES` | | `15` | Interval poll produk di mode standby |
| `BETWEEN_TRANSACTION_SECONDS_MIN` | | `15` | Jeda minimum antar transaksi (detik) |
| `BETWEEN_TRANSACTION_SECONDS_MAX` | | `45` | Jeda maksimum antar transaksi (detik) |

\* Hanya provider yang dipilih yang perlu diisi.

---

## Format `data.csv`

```csv
nik
3501042403590002
3501042404710005
```

Hanya kolom `nik` (16 digit) yang wajib ada. Kolom tambahan boleh ditambahkan
dan tidak akan mengganggu runtime (dipersiapkan untuk fitur registrasi NIK).

---

## Menjalankan

```bash
npm start
```

Pertama kali dijalankan, aplikasi akan menanyakan:
1. Username & PIN (jika belum di `.env`)
2. Provider captcha (jika belum di `.env`)
3. API key captcha (jika belum di `.env`)
4. Pilihan mode (`Habiskan Kuota` / `Mode Harian` / `Mode Standby`)

Semua jawaban yang diinput akan otomatis disimpan ke `.env` sehingga tidak
ditanyakan kembali saat restart.

---

## Logika Prioritas Kuota

Untuk setiap NIK yang diproses:

```
Customer punya Rumah Tangga?
  └─ quota > 0?  ✅  → transaksi quantity=1, coordinate="-,-"
  └─ quota = 0?  ⬇️ cek Usaha Mikro
Customer punya Usaha Mikro?
  └─ quota >= 2? ✅  → transaksi quantity=2, coordinate dari merchant.location
  └─ habis?      ❌  → lewati NIK ini
```

---

## Mode Scheduler

### Habiskan Kuota
Habiskan seluruh `stockAvailable` secepat mungkin. Token expired → login ulang
otomatis dan lanjutkan.

### Mode Harian
Input jumlah hari → stok dibagi merata dan disebarkan secara acak di dalam
rentang jam kerja setiap harinya.

### Mode Standby
Aplikasi polling produk setiap `STANDBY_POLL_MINUTES` menit. Jika `stockDate`
terdeteksi hari ini atau kemarin:
- Distribusi **tidak** dimulai di hari yang sama dengan `stockDate`
- Mulai distribusi pada hari berikutnya menggunakan mekanik Mode Harian
- State disimpan ke `state.json`; resume otomatis setelah restart

---

## Lisensi

Proyek ini dilisensikan di bawah **MIT License** — bebas digunakan **untuk
tujuan edukasi**. Penggunaan untuk keperluan komersial atau distribusi ulang
dengan imbalan uang **dilarang keras**.

---

> Made with ❤️ for educational purposes only. Use responsibly.
