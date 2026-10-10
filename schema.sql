-- ============================================================
-- SCHEMA DATABASE: Absensi Sholat (versi MySQL)
-- File ini OPSIONAL -- server.js sudah otomatis membuat tabel-tabel
-- ini sendiri saat pertama kali jalan. Simpan file ini cuma buat
-- jaga-jaga / referensi, atau kalau IT sekolah minta dijalankan manual.
-- ============================================================

CREATE TABLE IF NOT EXISTS siswa (
    kts_id  VARCHAR(64) PRIMARY KEY,
    nama    VARCHAR(255) NOT NULL,
    kelas   VARCHAR(50),
    agama   VARCHAR(20) NOT NULL DEFAULT 'muslim'
);

CREATE TABLE IF NOT EXISTS siswa_sementara (
    kode  VARCHAR(10) PRIMARY KEY,
    nama  VARCHAR(50) NOT NULL,
    agama VARCHAR(20) NOT NULL DEFAULT 'muslim',
    aktif TINYINT(1) NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS absensi (
    id           INT AUTO_INCREMENT PRIMARY KEY,
    kts_id       VARCHAR(64) NOT NULL,
    tanggal      VARCHAR(10) NOT NULL,
    waktu_token  TEXT,
    token_ts     BIGINT,
    waktu_keluar TEXT,
    status       VARCHAR(20) NOT NULL DEFAULT 'belum', -- belum | sudah_sholat | sudah_pulang | izin
    keterangan   VARCHAR(255) NULL, -- alasan izin (sakit/haid/izin/dll), diisi role Scan Khusus
    UNIQUE KEY uniq_kts_tanggal (kts_id, tanggal)
);

-- role: 'admin' (bisa lebih dari satu akun), 'guru' (mode pemberi/penarik token dipilih di halaman /scan),
-- 'scan_khusus' (beri token ke siswa berhalangan/sakit/haid/izin lewat /scan-khusus)
CREATE TABLE IF NOT EXISTS users (
    id            INT AUTO_INCREMENT PRIMARY KEY,
    username      VARCHAR(64) UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    salt          TEXT NOT NULL,
    role          VARCHAR(20) NOT NULL
);

-- Jadwal piket per akun guru: hari 1=Senin ... 7=Minggu.
-- Kalau akun tidak punya baris di tabel ini sama sekali, artinya BELUM diatur admin
-- -> akun itu bebas piket kapan saja (tidak dibatasi).
CREATE TABLE IF NOT EXISTS jadwal_piket (
    user_id INT NOT NULL,
    hari    TINYINT NOT NULL,
    PRIMARY KEY (user_id, hari),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX idx_absensi_tanggal ON absensi(tanggal);

-- Catatan: akun admin default (admin/admin123) TIDAK perlu di-insert manual
-- di sini -- server.js sudah otomatis membuatkannya sendiri saat pertama kali jalan.
