# PRD — Sistem Absensi Sholat Sekolah (dzuhur.sniski.sch.id)

**Status:** Live, dipakai sekolah. Dibangun bertahap lewat banyak sesi AI.
**Dokumen ini untuk:** siapa pun (AI lain atau developer manusia) yang melanjutkan project ini.

---

## 1. Ringkasan

Aplikasi web untuk mencatat kehadiran sholat siswa pakai scan barcode KTS/NISN.
Alur dasar: siswa sholat → scan KTS ke **Guru Pemberi Token** → dapat "token" hari itu →
tunjukkan KTS lagi di **Gerbang** (Guru Penarik Token) → boleh pulang.

Siswa yang berhalangan (sakit/haid/izin) bisa dikasih **token izin** manual lewat mode
**Scan Khusus** (bagian dari akun Guru, bukan role terpisah), lengkap dengan keterangan
yang nanti muncul lagi di gerbang.

## 2. Stack Teknis

- **Backend:** Node.js murni (built-in `http`, tanpa framework seperti Express), file tunggal `server.js`
- **Database:** MySQL (lewat `mysql2/promise`, wrapper ada di `db.js`), koneksi dari `config.json` → `databaseUrl`
- **Frontend:** HTML+CSS+JS vanilla, tanpa build step, satu file per halaman di `/public`
- **Kamera/barcode:** html5-qrcode (CDN)
- **Export:** jsPDF + jspdf-autotable (PDF), SheetJS/xlsx (Excel) — keduanya CDN, **tidak nambah dependency server**
- **Styling:** neumorphism (soft-UI), 1 file `style.css` dipakai semua halaman

## 3. Role & Autentikasi

| Role | Jumlah akun | Akses |
|---|---|---|
| `admin` | **bisa lebih dari 1** | Semua: kelola siswa, akun guru/admin, kartu sementara, riwayat, audio, background welcome |
| `guru` | banyak | Halaman `/scan`, dengan 3 **mode** yang dipilih sendiri di halaman (bukan role terpisah): **Pemberi Token**, **Penarik Token** (gerbang), **Scan Khusus** (token izin) |

> Role `scan_khusus` yang dulu sempat ada sebagai akun terpisah **sudah dihapus** — fungsinya
> sekarang jadi mode ke-3 di akun guru. Kalau masih ada akun lama dengan role itu di database,
> backend masih menerimanya (backward-compat) tapi tidak bisa dibuat baru lagi dari UI.

**Login 1 device:** setiap akun cuma boleh aktif di 1 sesi/device. Login baru otomatis
nge-logout device lama (sengaja, bukan bug). Implementasinya in-memory (`Map` di server,
bukan di database) — artinya kalau server di-restart, semua orang harus login ulang (ini
sudah perilaku lama, bukan hal baru).

**Hapus akun = paksa logout:** kalau admin menghapus sebuah akun (satu-satu atau massal),
device yang sedang login pakai akun itu langsung ter-invalidasi sesinya (request berikutnya
dapat 401 dan diarahkan ke halaman login oleh `common.js`).

**Minimal 1 admin:** sistem menolak penghapusan admin terakhir, dan menolak admin menghapus
akunnya sendiri yang sedang login.

## 4. Fitur Lengkap

- Scan KTS (kamera, flip depan/belakang) atau input manual nomor
- 3 mode di halaman guru: Pemberi Token / Penarik Token (Gerbang) / Scan Khusus
- Token izin (Scan Khusus): pilih alasan cepat (Sakit/Haid/Izin) atau ketik manual, keterangan
  tampil lagi di gerbang saat siswa pulang
- Role agama per siswa (muslim/non-muslim) — non-muslim tidak perlu token, langsung boleh pulang
- Kartu Sementara: 700 kode otomatis (bisa nambah lagi), buat siswa yang belum punya KTS fisik
- Data Siswa (`/siswa`): dikelompokkan per jurusan → kelas (accordion), edit nama/kelas/NISN
  inline, pilih & hapus massal
- Akun Guru & Staff (`/akun-guru`): tambah akun (role Guru/Admin), atur jadwal piket per hari
  (opsional — kalau kosong, bebas piket kapan saja), reset password (dengan tombol mata),
  pilih & hapus massal
- Jadwal Piket: guru hanya bisa pakai mode Pemberi/Penarik di hari jadwalnya (kalau diset);
  mode Scan Khusus **tidak** dibatasi jadwal piket
- Rekap harian admin: dikelompokkan per status (Sudah Pulang → Sudah Sholat → Izin → Belum
  Sholat) dalam 1 tabel, auto-refresh 2 detik, **Export PDF** & **Export Excel**
- Riwayat 6 bulan, dikelompokkan per kelas/jurusan, bisa cetak
- **Rekap Absensi** (`/rekap`): matriks siswa × hari dengan pilihan lingkup **Harian / Mingguan / Bulanan**.
  Mingguan = Senin–Sabtu, Bulanan = semua hari di bulan itu **tanpa Minggu** (Minggu libur, tidak dihitung);
  Harian = 1 tanggal pilihan. Navigasi sebelumnya/berikutnya menyesuaikan lingkup (±1 hari / ±7 hari / ±1 bulan),
  pilih tanggal bebas, filter kelas, total Sholat/Izin/Belum per siswa, Export PDF (landscape) & Excel.
  Hari tanpa satu pun data scan dianggap libur/belum ada data (tanda •) dan **tidak dihitung "Belum"**
- Export rekap harian (PDF/Excel) sekarang punya kolom **Tanggal**
- **Jenis kelamin siswa** (`L`/`P`, boleh kosong): diisi di Data Siswa (per baris, **set massal** lewat checkbox + tombol
  Set P / Set L, atau kolom ke-4 di import CSV: L/P/Laki-laki/Perempuan). Dipakai untuk logika haid.
- **Logika haid** (mode Scan Khusus, tombol 🩸 Haid):
  - Tombol Haid **hanya muncul untuk siswi (P)**. Laki-laki, gender kosong, dan kartu sementara ditolak server
    (`code: bukan_putri`) dengan pesan jelas. Laki-laki tetap bisa izin sakit/izin biasa.
  - Scan Haid pertama membuka **episode** dengan **H1 = hari itu**; guru boleh mengisi "sudah haid sejak tanggal ..."
    (tidak boleh tanggal masa depan). Hari ke-N dihitung dari H1 (**hari kalender, Minggu ikut dihitung**).
  - Mulai **hari ke-8** (`BATAS_HAID_HARI = 7` di `server.js`), setiap kali siswi itu discan Haid muncul **popup peringatan**
    (server membalas `code: peringatan_haid`). Di popup: tanggal mulai bisa dikoreksi, **keterangan wajib**, dan 2 pilihan:
    ✅ **Lanjut beri token** (token izin diberikan) atau ⛔ **Tidak beri token / selidiki dulu** (tidak ada token, episode
    ditandai `diselidiki`). Peringatan muncul **setiap hari** sampai siswi discan **sholat normal** (token pemberi) —
    saat itu episode otomatis **selesai** (`tanggal_selesai` = hari haid terakhir).
  - Setiap keputusan guru dicatat (tanggal, hari ke-N, aksi, keterangan) di kolom `catatan` episode.
  - Jarak antar-H1 (**siklus**) ditampilkan di popup bila siswi sudah punya episode sebelumnya (hanya informasi, tidak memblokir).
  - Dashboard admin: kartu **🩸 Haid Berjalan** (yang lewat batas / diselidiki di urutan atas).
  - Rekap harian & rekap mingguan/bulanan menampilkan **"Haid"** (simbol `H`, kolom Haid sendiri) — keputusan pemilik:
    tidak ada pembatasan privasi di rekap internal.
  - Mengganti NISN memindahkan episode; menghapus siswa ikut menghapus catatan haidnya.
- **Halaman Orang Tua / Wali Kelas** (`/orangtua`, tombol di halaman depan):
  - *Orang Tua / Murid* (publik): masukkan **NISN** → riwayat sholat anak per tanggal untuk periode pilihan
    (dari–sampai, atau Bulan ini / Bulan lalu / 3 bulan terakhir): Sholat, Izin, Belum, **Kehadiran %**
    (= Sholat ÷ (Sholat + Belum); izin tidak dihitung; Minggu libur; hari tanpa data sama sekali tidak dihitung).
    Export **PDF & Excel** (cocok untuk laporan / nilai rapor). Siswa non-muslim ditandai tanpa hitungan.
  - *Wali Kelas*: pilih kelas → tabel rekap semua siswa kelas itu (klik nama = rincian per tanggal) + Export PDF & Excel.
    **Wajib login guru/admin** (diarahkan ke `/login?next=/orangtua`, kembali otomatis setelah login).
  - **Privasi (keputusan desain):** halaman ini hanya menampilkan **"Izin" tanpa alasan** — kata "haid"/keterangan
    tidak pernah dikirim ke halaman ini, karena dilihat orang tua & dipakai untuk rapor. Pencarian publik dibatasi
    **40 permintaan / 10 menit / IP** (HTTP 429) agar NISN tidak bisa ditebak beruntun.
- **Halaman depan** (`welcome.html`): teks "Tentang sistem ini", dan 2 tombol — 🔐 Masuk Guru / Admin dan
  👨‍👩‍👧 Orang Tua / Wali Kelas — posisinya dinaikkan ke antara tengah dan bawah layar.
- Audio notifikasi kustom (upload/rekam, terpisah untuk "Berhasil"/"Gagal")
- Background custom untuk halaman welcome/kiosk
- Tombol mata (lihat/sembunyikan) di field password (login & tambah akun guru)

## 5. Struktur Data (ringkas — detail di `schema.sql`)

- **users**: id, username, password_hash, salt, role (`admin`/`guru`)
- **jadwal_piket**: user_id, hari (1–7) — kosong berarti bebas piket
- **siswa**: kts_id (PK), nama, kelas, agama, **jenis_kelamin** (`L`/`P`/NULL)
- **absensi**: id, kts_id, tanggal, waktu_token, token_ts, waktu_keluar, status
  (`belum`/`sudah_sholat`/`sudah_pulang`/`izin`), **keterangan** (alasan izin), **alasan_jenis** (`haid`/`sakit`/`izin`/`lain`)
- **siklus_haid**: id, kts_id, tanggal_mulai (H1), tanggal_selesai, status (`berjalan`/`selesai`), diselidiki, catatan
- **kartu_sementara**: kode, agama, aktif

## 6. Daftar API (semua di `server.js`, satu file)

```
POST /api/login                    POST /api/logout
GET  /api/ringkasan                (publik — angka ringkasan hari ini)
POST /api/token                    (mode Pemberi)
POST /api/verify                   (mode Penarik/gerbang)
POST /api/token-khusus             (mode Scan Khusus — role guru/admin)
GET  /api/jadwal-saya

-- publik --
GET  /api/publik/riwayat?nisn=&dari=&sampai=     (rate-limited 40/10 menit/IP; hanya "izin", tanpa alasan)
-- login guru/admin --
GET  /api/haid/info?kts_id=                      (boleh_haid, episode berjalan, hari ke-N)
GET  /api/walas/kelas   GET /api/walas/rekap?kelas=&dari=&sampai=   GET /api/walas/siswa?kts_id=&dari=&sampai=
POST /api/token-khusus  body: kts_id, jenis(haid|sakit|izin|lain), keterangan, mulai_sejak?, konfirmasi?(lanjut|tidak)
-- butuh login ADMIN --
GET  /api/haid/berjalan    POST /api/siswa/jenis-kelamin (set massal)
GET  /api/rekap                    GET  /api/siswa            POST /api/siswa
POST /api/siswa/agama              POST /api/siswa/delete     POST /api/siswa/delete-massal
POST /api/siswa/edit               POST /api/siswa/import     POST /api/siswa/reset
GET  /api/siswa-semua
GET  /api/users                    POST /api/users            POST /api/users/jadwal
POST /api/users/password           POST /api/users/delete     POST /api/users/delete-massal
GET  /api/sementara                POST /api/sementara/tambah POST /api/sementara/aktif
POST /api/sementara/aktif-semua    POST /api/sementara/agama
GET  /api/audio/status             POST /api/audio            POST /api/audio/hapus
GET  /api/riwayat                  GET  /api/riwayat/detail   GET  /api/riwayat/rekap?mode=harian|mingguan|bulanan&tanggal=YYYY-MM-DD
                                   (alias lama /api/riwayat/mingguan masih jalan)
GET  /api/welcome-bg/status        POST /api/welcome-bg       POST /api/welcome-bg/hapus
```

## 7. Halaman

| Route | Siapa | Isi |
|---|---|---|
| `/login` | semua | form login |
| `/admin` | admin | dashboard: rekap + link ke halaman lain |
| `/siswa` | admin | kelola data siswa (grup jurusan/kelas, edit, hapus massal) |
| `/akun-guru` | admin | kelola akun guru & admin |
| `/orangtua` | publik (tab Wali Kelas butuh login guru) | riwayat sholat siswa per NISN / rekap per kelas, export PDF/Excel |
| `/cetak-kartu` | admin | kartu sementara |
| `/riwayat` | admin | riwayat 6 bulan |
| `/rekap` | admin | rekap harian/mingguan/bulanan, export PDF/Excel (`/rekap-mingguan` lama redirect ke sini) |
| `/scan` | guru | 3 mode: Pemberi / Penarik / Scan Khusus |
| `/` , `/welcome` | publik | layar welcome/kiosk |

> `/scan-khusus` (halaman lama) sekarang cuma redirect ke `/scan?mode=khusus`.

## 8. Masalah Berulang yang Perlu Diwaspadai

**"Rute tidak ditemukan" setelah update dikirim ke IT** — ini sudah terjadi **3 kali**
di project ini, selalu dengan penyebab yang sama: frontend (file `.html`) sudah diganti
IT, tapi `server.js` belum diganti dan/atau proses Node belum di-restart. Kalau muncul
lagi: **pastikan ke IT bahwa setelah upload file baru, proses Node WAJIB di-restart**
(bukan cuma upload file).

Sebelumnya juga sempat ditambahkan `GET /api/versi` di satu revisi untuk mengecek versi
server yang sedang jalan langsung dari browser — berguna untuk diagnosis cepat kalau
error serupa muncul lagi (cek apakah file di endpoint itu sudah menunjukkan versi
terbaru).

**Akun guru tidak bisa dihapus / guru tidak bisa login** — dua akar masalah yang berhasil direproduksi dan
sudah diperbaiki:
1. *Hapus akun gagal* kalau akun punya jadwal piket **dan** tabel `jadwal_piket` di database server dibuat dari
   versi lama tanpa `ON DELETE CASCADE` (`CREATE TABLE IF NOT EXISTS` tidak memperbaiki tabel lama). Error yang
   keluar: "Cannot delete or update a parent row". Perbaikan: `deleteUser()` sekarang menghapus jadwal piket
   secara eksplisit lebih dulu, tidak lagi bergantung pada cascade. Efek lanjutannya: nama pengguna tertahan
   "sudah dipakai" sehingga akun tidak bisa dibuat ulang.
2. *Login gagal karena spasi di ujung password* (keyboard HP sering menambah spasi setelah kata; form lama
   berupa kolom teks biasa). Perbaikan: password baru/reset di-`trim()`, login menerima password dengan/tanpa
   spasi di ujung (termasuk akun lama yang terlanjur tersimpan dengan 1 spasi), dan input login/tambah akun
   diberi `autocapitalize="none" autocorrect="off"`. Username sudah case-insensitive dan di-trim.
Penyebab lain yang mungkin tetapi tidak bisa dibuktikan dari kode: 1 akun dipakai beberapa guru (aturan 1 device
saling menendang), atau pesan "Bukan Jadwal Piket" yang terkesan seperti gagal login.

## 9. Testing yang Sudah Dilakukan

**Fitur haid + halaman orang tua/wali kelas:** 39 pengecekan otomatis terhadap MariaDB asli dari database kosong, semuanya
lolos (aturan gender, batas hari ke-7/ke-8, keputusan lanjut/tidak + catatan, koreksi H1, tanggal masa depan, penutupan
episode saat sholat normal, siklus 2 episode, ganti NISN, hapus siswa, set massal gender, privasi halaman publik, akses
wali kelas, rate limit). Regresi: login, hapus akun + logout paksa, rekap.


Semua fitur di atas sudah diuji end-to-end pakai MariaDB asli (bukan cuma `node --check`):
login, buat/hapus akun (satu & massal + force-logout-nya), token pemberi/penarik, scan
khusus + tampil di gerbang, edit siswa, hapus massal siswa, single-device login,
pembatasan role saat buat akun. **Belum diuji:** render visual neumorphism di browser
sungguhan (cuma dicek secara kode/CSS, bukan screenshot), dan belum diuji di hosting IT
yang sebenarnya.

**Keterbatasan yang sengaja dibiarkan (bisa jadi pekerjaan berikutnya):**
- Tab Wali Kelas belum terikat ke kelas tertentu: **semua akun guru bisa melihat semua kelas**. Pembatasan "guru hanya
  kelas binaannya" butuh data wali kelas per akun.
- Batas hari haid (`BATAS_HAID_HARI`) berupa konstanta di kode, belum bisa diubah dari halaman admin.
- Haid hanya tercatat saat siswi discan di Scan Khusus; hari ke-N dihitung dari tanggal, bukan dari kehadiran. Jika siswi
  tidak masuk lama lalu mengalami haid baru, guru perlu mengoreksi tanggal mulai di popup.
- Prediksi tanggal haid berikutnya belum ada (data siklus sudah tersimpan untuk itu).

## 10. Rencana Jangka Panjang (belum mulai)

Dikembangkan jadi APK (Capacitor), notifikasi WhatsApp ke orang tua, dashboard grafik,
hardening keamanan — rencana dijual ke sekolah lain (~Rp 10 juta per sekolah,
perorangan, bukan atas nama perusahaan).

## 11. Cara Deploy / Update ke Server IT

1. Upload seluruh isi folder (replace semua file lama) ke hosting
2. Pastikan `config.json` di server tetap berisi `databaseUrl` yang benar (jangan ketimpa)
3. Kalau ada perubahan skema (kolom baru dsb.), server otomatis `ALTER TABLE` saat start
   (lihat `initSchema()` di `server.js`) — aman dijalankan berkali-kali
4. **WAJIB restart proses Node** setelah upload — ini penyebab paling sering error
   "Rute tidak ditemukan"
