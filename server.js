/**
 * Absensi Sholat — Server
 * Jalankan dengan: node server.js
 * BUTUH "npm install mysql2" sekali di awal (database sekarang di server terpisah,
 * bukan file lokal lagi). Set juga environment variable DATABASE_URL dari hosting.
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('./db.js'); // dulu: const { DatabaseSync } = require('node:sqlite');

// Sesi login disimpan di memori (hilang kalau server di-restart — guru tinggal login lagi, aman)
const sessions = new Map(); // sid -> { id, username, role }
const SESSION_MAX_AGE = 60 * 60 * 24 * 30; // 30 hari, biar guru tidak perlu login ulang tiap buka

// ================= KONFIGURASI =================
const PORT = process.env.PORT || 3000;
const HTTPS_PORT = process.env.HTTPS_PORT || 3443;
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const CONFIG_PATH = path.join(ROOT, 'config.json');
const CERT_PATH = path.join(ROOT, 'cert.pem');
const KEY_PATH = path.join(ROOT, 'key.pem');
const TIMEZONE = 'Asia/Jakarta';
// Catatan: folder data/ & file absensi.db lokal SUDAH TIDAK DIPAKAI lagi,
// karena data sekarang disimpan di database eksternal (lihat db.js).

let config = { adminKey: 'ganti-password-ini-1234', tokenValidHours: 5 };
if (fs.existsSync(CONFIG_PATH)) {
  try {
    config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    if (!config.tokenValidHours) config.tokenValidHours = 5;
  }
  catch (e) { console.error('config.json rusak, pakai default.'); }
} else {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

// ================= DATABASE =================
// Dulu pakai node:sqlite (file lokal). Sekarang pakai db.js (PostgreSQL, server terpisah).
// Semua query jadi ASYNC (pakai await), makanya dibungkus fungsi async di bawah.

async function initSchema() {
  await db.run(`
    CREATE TABLE IF NOT EXISTS siswa (
      kts_id VARCHAR(64) PRIMARY KEY,
      nama VARCHAR(255) NOT NULL,
      kelas VARCHAR(50)
    );
  `);
  await db.run(`
    CREATE TABLE IF NOT EXISTS absensi (
      id INT AUTO_INCREMENT PRIMARY KEY,
      kts_id VARCHAR(64) NOT NULL,
      tanggal VARCHAR(10) NOT NULL,
      waktu_token TEXT,
      token_ts BIGINT,
      waktu_keluar TEXT,
      status VARCHAR(20) NOT NULL DEFAULT 'belum',
      UNIQUE KEY uniq_kts_tanggal (kts_id, tanggal)
    );
  `);
  await db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INT AUTO_INCREMENT PRIMARY KEY,
      username VARCHAR(64) UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      salt TEXT NOT NULL,
      role VARCHAR(20) NOT NULL
    );
  `);
  // Tabel kartu sementara: 700 kode (001-700), terpisah dari tabel siswa asli.
  // Dipakai buat siswa yang belum punya KTS asli — kode & nama sudah digenerate
  // otomatis oleh sistem (lihat seedKartuSementara), admin tinggal atur agama & aktif/nonaktifnya.
  await db.run(`
    CREATE TABLE IF NOT EXISTS siswa_sementara (
      kode VARCHAR(10) PRIMARY KEY,
      nama VARCHAR(50) NOT NULL,
      agama VARCHAR(20) NOT NULL DEFAULT 'muslim',
      aktif TINYINT(1) NOT NULL DEFAULT 1
    );
  `);
  // MySQL tidak punya "CREATE INDEX IF NOT EXISTS", jadi kalau index-nya
  // sudah ada dari sebelumnya, error-nya ditangkap & diabaikan (aman).
  try {
    await db.run('CREATE INDEX idx_absensi_tanggal ON absensi(tanggal)');
  } catch (e) { /* index sudah ada, aman diabaikan */ }
  // Kolom "agama" ditambahkan belakangan — kalau tabel siswa dibuat sebelum fitur ini ada,
  // ALTER TABLE ini yang menambahkannya. Kalau kolomnya sudah ada, error-nya diabaikan (aman).
  // Peran lama 'pemberi' & 'penarik' digabung jadi 'guru' (mode dipilih di halaman scan)
  await db.run("UPDATE users SET role = 'guru' WHERE role IN ('pemberi', 'penarik')");
  try {
    await db.run(`ALTER TABLE siswa ADD COLUMN agama VARCHAR(20) NOT NULL DEFAULT 'muslim'`);
  } catch (e) { /* kolom sudah ada, aman diabaikan */ }
  // Jadwal piket per akun guru: hari 1=Senin ... 7=Minggu. Kalau akun tidak punya baris
  // di tabel ini sama sekali, artinya BELUM diatur admin -> bebas piket kapan saja (tidak dibatasi).
  await db.run(`
    CREATE TABLE IF NOT EXISTS jadwal_piket (
      user_id INT NOT NULL,
      hari TINYINT NOT NULL,
      PRIMARY KEY (user_id, hari),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
  `);
  // Kolom "keterangan" dipakai role baru "Scan Khusus" — catatan alasan siswa berhalangan
  // (sakit/haid/izin/dll), diketik manual, statusnya jadi 'izin' di tabel absensi.
  try {
    await db.run(`ALTER TABLE absensi ADD COLUMN keterangan VARCHAR(255) NULL`);
  } catch (e) { /* kolom sudah ada, aman diabaikan */ }
  // Jenis kelamin siswa ('L'/'P', boleh kosong) — dipakai fitur haid (hanya siswi 'P').
  try { await db.run(`ALTER TABLE siswa ADD COLUMN jenis_kelamin VARCHAR(1) NULL`); } catch (e) { /* sudah ada */ }
  // Jenis alasan izin ('haid','sakit','izin','lain') — terstruktur, supaya logika haid tidak bergantung pada teks ketikan guru.
  try { await db.run(`ALTER TABLE absensi ADD COLUMN alasan_jenis VARCHAR(20) NULL`); } catch (e) { /* sudah ada */ }
  // Satu baris = satu episode haid (H1 = tanggal_mulai). Jarak antar H1 = siklus haid siswi tsb.
  await db.run(`
    CREATE TABLE IF NOT EXISTS siklus_haid (
      id INT AUTO_INCREMENT PRIMARY KEY,
      kts_id VARCHAR(64) NOT NULL,
      tanggal_mulai VARCHAR(10) NOT NULL,
      tanggal_selesai VARCHAR(10) NULL,
      status VARCHAR(12) NOT NULL DEFAULT 'berjalan',
      diselidiki TINYINT(1) NOT NULL DEFAULT 0,
      catatan TEXT NULL,
      INDEX idx_haid_kts (kts_id)
    );
  `);
  // Role sekarang ada 2 akun login: 'admin' (bisa lebih dari satu akun) dan 'guru'.
  // "Scan Khusus" bukan akun terpisah lagi — cukup salah satu mode di halaman /scan milik akun guru.
  // (baris ALTER role di atas tidak perlu diubah karena kolomnya VARCHAR bebas isi).
}

// Isi otomatis 700 kode kartu sementara (001-700) kalau tabelnya masih kosong.
// Nama otomatis dibuat "SHOLATSNISKI(001)" dst — bukan nama siswa asli, karena kartu ini
// belum tentu ketuker ke siswa mana (pairing-nya dicatat manual di luar sistem oleh admin).
async function seedKartuSementara() {
  const row = await db.get('SELECT COUNT(*) AS n FROM siswa_sementara');
  if (Number(row.n) > 0) return; // sudah pernah diisi, jangan diisi ulang
  const baris = [];
  const params = [];
  for (let i = 1; i <= 700; i++) {
    const kode = String(i).padStart(3, '0');
    baris.push('(?, ?)');
    params.push(kode, `SHOLATSNISKI(${kode})`);
  }
  await db.run(`INSERT INTO siswa_sementara (kode, nama) VALUES ${baris.join(', ')}`, params);
  console.log('700 kode kartu sementara (001-700) berhasil dibuat otomatis.');
}

// (Catatan: nonaktifkan "satu-satu" pakai kolom aktif per baris; nonaktifkan "semua sekaligus"
// cukup UPDATE massal ke kolom aktif yang sama — lihat aktifkanSemuaSementara di bawah.)

// Tambah kartu sementara BARU, melanjutkan dari nomor tertinggi yang sudah ada (tidak dibatasi 700).
// Dipakai kalau butuh kartu pengganti (misal kartu sementara siswa hilang) atau nambah kuota.
async function tambahKartuSementaraBaru(jumlah) {
  const mulai = (await stmt.kodeSementaraTertinggi()) + 1;
  const baris = [];
  const params = [];
  const kodeBaru = [];
  for (let i = 0; i < jumlah; i++) {
    const kode = String(mulai + i).padStart(3, '0');
    baris.push('(?, ?)');
    params.push(kode, `SHOLATSNISKI(${kode})`);
    kodeBaru.push(kode);
  }
  await db.run(`INSERT INTO siswa_sementara (kode, nama) VALUES ${baris.join(', ')}`, params);
  return kodeBaru;
}

// Kumpulan query, gaya penulisan mirip "stmt" yang lama, tapi sekarang async.
const stmt = {
  getSiswa: (kts_id) => db.get('SELECT * FROM siswa WHERE kts_id = ?', [kts_id]),
  addSiswa: (kts_id, nama, kelas, jk) => db.run(
    `INSERT INTO siswa (kts_id, nama, kelas, jenis_kelamin) VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE nama = VALUES(nama), kelas = VALUES(kelas),
       jenis_kelamin = COALESCE(VALUES(jenis_kelamin), jenis_kelamin)`,
    [kts_id, nama, kelas, jk || null]
  ),
  setJenisKelamin: async (ktsIds, jk) => {
    if (!ktsIds.length) return;
    await db.run(`UPDATE siswa SET jenis_kelamin = ? WHERE kts_id IN (${ktsIds.map(() => '?').join(',')})`, [jk, ...ktsIds]);
  },
  // ---- riwayat sholat (halaman Orang Tua / Wali Kelas) ----
  absensiSiswaRange: (kts_id, dari, sampai) => db.all(
    `SELECT tanggal, status, waktu_token FROM absensi WHERE kts_id = ? AND tanggal BETWEEN ? AND ?`, [kts_id, dari, sampai]),
  tanggalAktif: (dari, sampai) => db.all(`SELECT DISTINCT tanggal FROM absensi WHERE tanggal BETWEEN ? AND ?`, [dari, sampai]),
  siswaPerKelas: (kelas) => db.all(`SELECT kts_id, nama, kelas, agama FROM siswa WHERE kelas = ? ORDER BY nama`, [kelas]),
  absensiKelasRange: (kelas, dari, sampai) => db.all(
    `SELECT a.kts_id, a.tanggal, a.status FROM absensi a JOIN siswa s ON s.kts_id = a.kts_id
     WHERE s.kelas = ? AND a.tanggal BETWEEN ? AND ?`, [kelas, dari, sampai]),
  daftarKelas: () => db.all(`SELECT DISTINCT kelas FROM siswa WHERE kelas IS NOT NULL AND kelas <> '' ORDER BY kelas`),
  // ---- siklus haid ----
  getEpisodeAktif: (kts_id) => db.get(`SELECT * FROM siklus_haid WHERE kts_id = ? AND status = 'berjalan' ORDER BY id DESC LIMIT 1`, [kts_id]),
  getEpisodeSebelumnya: (kts_id, exceptId) => db.get(`SELECT * FROM siklus_haid WHERE kts_id = ? AND id <> ? ORDER BY tanggal_mulai DESC LIMIT 1`, [kts_id, exceptId || 0]),
  mulaiEpisode: (kts_id, tanggal) => db.run(`INSERT INTO siklus_haid (kts_id, tanggal_mulai, status) VALUES (?, ?, 'berjalan')`, [kts_id, tanggal]),
  ubahMulaiEpisode: (id, tanggal) => db.run(`UPDATE siklus_haid SET tanggal_mulai = ? WHERE id = ?`, [tanggal, id]),
  catatEpisode: (id, baris, diselidiki) => db.run(`UPDATE siklus_haid SET catatan = CONCAT(COALESCE(catatan, ''), ?), diselidiki = ? WHERE id = ?`, [baris, diselidiki ? 1 : 0, id]),
  tutupEpisode: (id, tanggal) => db.run(`UPDATE siklus_haid SET status = 'selesai', tanggal_selesai = ? WHERE id = ?`, [tanggal, id]),
  hariHaidTerakhir: async (kts_id) => {
    const r = await db.get(`SELECT MAX(tanggal) AS t FROM absensi WHERE kts_id = ? AND alasan_jenis = 'haid'`, [kts_id]);
    return r && r.t ? r.t : null;
  },
  listEpisodeBerjalan: () => db.all(
    `SELECT h.id, h.kts_id, h.tanggal_mulai, h.diselidiki, h.catatan, s.nama, s.kelas
     FROM siklus_haid h JOIN siswa s ON s.kts_id = h.kts_id
     WHERE h.status = 'berjalan' ORDER BY h.tanggal_mulai`
  ),
  listSiswa: () => db.all('SELECT * FROM siswa ORDER BY kelas, nama'),
  countSiswa: async () => {
    const row = await db.get('SELECT COUNT(*) AS n FROM siswa');
    return Number(row.n);
  },
  getAbsensi: (kts_id, tanggal) => db.get('SELECT * FROM absensi WHERE kts_id = ? AND tanggal = ?', [kts_id, tanggal]),
  insertAbsensi: (kts_id, tanggal, waktu, ts) => db.run(
    `INSERT INTO absensi (kts_id, tanggal, waktu_token, token_ts, status) VALUES (?, ?, ?, ?, 'sudah_sholat')`,
    [kts_id, tanggal, waktu, ts]
  ),
  updateJadiSholat: (waktu, ts, id) => db.run(
    `UPDATE absensi SET status='sudah_sholat', waktu_token=?, token_ts=? WHERE id=?`,
    [waktu, ts, id]
  ),
  updateJadiPulang: (waktu, id) => db.run(
    `UPDATE absensi SET status='sudah_pulang', waktu_keluar=? WHERE id=?`,
    [waktu, id]
  ),
  rekapHariIni: (tanggal) => db.all(
    `SELECT s.kts_id, s.nama, s.kelas, s.agama, a.status, a.waktu_token, a.waktu_keluar, a.keterangan, a.alasan_jenis
     FROM siswa s
     LEFT JOIN absensi a ON a.kts_id = s.kts_id AND a.tanggal = ?
     ORDER BY s.kelas, s.nama`,
    [tanggal]
  ),
  countStatusHariIni: async (tanggal) => {
    const row = await db.get(
      `SELECT
         SUM(CASE WHEN status IN ('sudah_sholat', 'sudah_pulang') THEN 1 ELSE 0 END) AS sudah_sholat,
         SUM(CASE WHEN status = 'sudah_pulang' THEN 1 ELSE 0 END) AS sudah_pulang,
         SUM(CASE WHEN status = 'izin' THEN 1 ELSE 0 END) AS sudah_izin
       FROM absensi WHERE tanggal = ?`,
      [tanggal]
    );
    return row || {};
  },
  resetAbsensiHariIni: (kts_id, tanggal) => db.run('DELETE FROM absensi WHERE kts_id = ? AND tanggal = ?', [kts_id, tanggal]),
  getUserByUsername: (username) => db.get('SELECT * FROM users WHERE username = ?', [username]),
  getUserById: (id) => db.get('SELECT * FROM users WHERE id = ?', [id]),
  addUser: (username, password_hash, salt, role) => db.run(
    'INSERT INTO users (username, password_hash, salt, role) VALUES (?, ?, ?, ?)',
    [username, password_hash, salt, role]
  ),
  listUsers: () => db.all(
    `SELECT u.id, u.username, u.role, COALESCE(GROUP_CONCAT(jp.hari ORDER BY jp.hari), '') AS jadwal
     FROM users u
     LEFT JOIN jadwal_piket jp ON jp.user_id = u.id
     GROUP BY u.id, u.username, u.role
     ORDER BY u.role, u.username`
  ),
  // Hapus jadwal piket dulu secara eksplisit, supaya tetap jalan walau FK di database sekolah
  // dulu dibuat tanpa ON DELETE CASCADE (CREATE TABLE IF NOT EXISTS tidak memperbaiki tabel lama).
  deleteUser: async (id) => {
    await db.run('DELETE FROM jadwal_piket WHERE user_id = ?', [id]);
    await db.run('DELETE FROM users WHERE id = ?', [id]);
  },
  getJadwal: (user_id) => db.all('SELECT hari FROM jadwal_piket WHERE user_id = ? ORDER BY hari', [user_id]),
  setJadwal: async (user_id, hariArr) => {
    await db.run('DELETE FROM jadwal_piket WHERE user_id = ?', [user_id]);
    if (!hariArr.length) return;
    const values = hariArr.map(() => '(?, ?)').join(', ');
    const params = [];
    for (const h of hariArr) params.push(user_id, h);
    await db.run(`INSERT INTO jadwal_piket (user_id, hari) VALUES ${values}`, params);
  },
  countUsers: async () => {
    const row = await db.get('SELECT COUNT(*) AS n FROM users');
    return Number(row.n);
  },
  updateUserPassword: (password_hash, salt, id) => db.run('UPDATE users SET password_hash = ?, salt = ? WHERE id = ?', [password_hash, salt, id]),
  updateAgamaSiswa: (kts_id, agama) => db.run('UPDATE siswa SET agama = ? WHERE kts_id = ?', [agama, kts_id]),
  countAdmin: async () => {
    const row = await db.get(`SELECT COUNT(*) AS n FROM users WHERE role = 'admin'`);
    return Number(row.n);
  },
  editSiswa: async (kts_id_lama, kts_id_baru, nama, kelas, jk) => {
    await db.run('UPDATE siswa SET kts_id = ?, nama = ?, kelas = ?, jenis_kelamin = ? WHERE kts_id = ?', [kts_id_baru, nama, kelas, jk || null, kts_id_lama]);
    if (kts_id_baru !== kts_id_lama) {
      await db.run('UPDATE absensi SET kts_id = ? WHERE kts_id = ?', [kts_id_baru, kts_id_lama]);
      await db.run('UPDATE siklus_haid SET kts_id = ? WHERE kts_id = ?', [kts_id_baru, kts_id_lama]);
    }
  },
  insertOrUpdateIzin: (kts_id, tanggal, waktu, ts, keterangan, jenis) => db.run(
    `INSERT INTO absensi (kts_id, tanggal, waktu_token, token_ts, status, keterangan, alasan_jenis)
     VALUES (?, ?, ?, ?, 'izin', ?, ?)
     ON DUPLICATE KEY UPDATE status = 'izin', waktu_token = VALUES(waktu_token), token_ts = VALUES(token_ts),
       keterangan = VALUES(keterangan), alasan_jenis = VALUES(alasan_jenis)`,
    [kts_id, tanggal, waktu, ts, keterangan, jenis || 'lain']
  ),

  listSementara: () => db.all('SELECT * FROM siswa_sementara ORDER BY kode'),
  getSementara: (kode) => db.get('SELECT * FROM siswa_sementara WHERE kode = ?', [kode]),
  updateAgamaSementara: (kode, agama) => db.run('UPDATE siswa_sementara SET agama = ? WHERE kode = ?', [agama, kode]),
  updateAktifSementara: (kode, aktif) => db.run('UPDATE siswa_sementara SET aktif = ? WHERE kode = ?', [aktif ? 1 : 0, kode]),
  aktifkanSemuaSementara: (aktif) => db.run('UPDATE siswa_sementara SET aktif = ?', [aktif ? 1 : 0]),
  historiRingkasan: (dari, sampai) => db.all(
    `SELECT s.kts_id, s.nama, s.kelas,
       COUNT(CASE WHEN a.status IN ('sudah_sholat', 'sudah_pulang') THEN 1 END) AS hari_sholat
     FROM siswa s
     LEFT JOIN absensi a ON a.kts_id = s.kts_id AND a.tanggal BETWEEN ? AND ?
     GROUP BY s.kts_id, s.nama, s.kelas
     ORDER BY s.kelas, s.nama`,
    [dari, sampai]
  ),
  absensiRange: (dari, sampai) => db.all(
    `SELECT kts_id, tanggal, status, keterangan, alasan_jenis FROM absensi WHERE tanggal BETWEEN ? AND ?`,
    [dari, sampai]
  ),
  hariAktifDalamRange: (dari, sampai) => db.all(
    `SELECT DISTINCT tanggal FROM absensi WHERE tanggal BETWEEN ? AND ? ORDER BY tanggal`,
    [dari, sampai]
  ),
  historiDetailSiswa: (kts_id, dari, sampai) => db.all(
    `SELECT tanggal, status FROM absensi WHERE kts_id = ? AND tanggal BETWEEN ? AND ? ORDER BY tanggal`,
    [kts_id, dari, sampai]
  ),
  hapusSiswa: (kts_id) => db.run('DELETE FROM siswa WHERE kts_id = ?', [kts_id]),
  hapusAbsensiSiswa: async (kts_id) => {
    await db.run('DELETE FROM absensi WHERE kts_id = ?', [kts_id]);
    await db.run('DELETE FROM siklus_haid WHERE kts_id = ?', [kts_id]); // catatan haid ikut terhapus bersama datanya
  },
  kodeSementaraTertinggi: async () => {
    const semua = await db.all('SELECT kode FROM siswa_sementara');
    let max = 0;
    for (const r of semua) {
      const n = parseInt(r.kode, 10);
      if (!isNaN(n) && n > max) max = n;
    }
    return max;
  },
};

// Cari siswa di tabel utama dulu; kalau tidak ketemu, coba di tabel kartu sementara
// (hanya yang statusnya aktif, dan hanya kalau saklar global kartu sementara masih nyala).
// Mengembalikan objek siswa yang sudah diseragamkan bentuknya, atau null kalau tidak ketemu di mana pun.
async function cariSiswaGabungan(kode) {
  const utama = await stmt.getSiswa(kode);
  if (utama) return { ...utama, sumber: 'utama' };

  const sementara = await stmt.getSementara(kode);
  if (sementara && sementara.aktif) {
    return { kts_id: sementara.kode, nama: sementara.nama, kelas: '', agama: sementara.agama, sumber: 'sementara' };
  }
  return null;
}

// Kalau belum ada akun sama sekali (server baru pertama kali jalan), buatkan 1 akun admin default
async function ensureDefaultAdmin() {
  const total = await stmt.countUsers();
  if (total === 0) {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = hashPassword('admin123', salt);
    await stmt.addUser('admin', hash, salt, 'admin');
    console.log('=====================================================');
    console.log('Akun admin default dibuat karena belum ada akun sama sekali.');
    console.log('  Username : admin');
    console.log('  Password : admin123');
    console.log('SEGERA login di /login lalu ganti password ini di halaman Admin!');
    console.log('=====================================================');
  }
}

// ================= HELPER =================
function todayStr() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE }).format(new Date());
}
function nowStr() {
  return new Date().toLocaleString('sv-SE', { timeZone: TIMEZONE });
}
function todayMinusHari(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE }).format(d);
}
// Angka hari ini sesuai zona waktu sekolah: 1=Senin ... 7=Minggu
function hariIniAngka() {
  const namaHari = new Intl.DateTimeFormat('en-US', { timeZone: TIMEZONE, weekday: 'long' }).format(new Date());
  const map = { Monday: 1, Tuesday: 2, Wednesday: 3, Thursday: 4, Friday: 5, Saturday: 6, Sunday: 7 };
  return map[namaHari];
}
// Cek apakah user boleh memberi/menarik token hari ini berdasarkan jadwal piket yang admin atur.
// Kalau admin belum mengatur jadwal sama sekali untuk akun itu (tabel kosong), akun bebas piket kapan saja.
async function cekJadwalPiket(user) {
  if (user.role !== 'guru') return { ok: true };
  const rows = await stmt.getJadwal(user.id);
  if (rows.length === 0) return { ok: true };
  const daftarHari = rows.map((r) => Number(r.hari));
  if (!daftarHari.includes(hariIniAngka())) {
    return { ok: false, pesan: 'Hari ini bukan jadwal piket kamu' };
  }
  return { ok: true };
}
function sendJSON(res, statusCode, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 15 * 1024 * 1024) req.destroy(); // batas 15MB, cukup untuk CSV ratusan siswa & rekaman audio pendek
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); }
      catch (e) { reject(new Error('Body bukan JSON yang valid')); }
    });
    req.on('error', reject);
  });
}
// (fungsi isAdmin berbasis x-admin-key sudah digantikan sistem login sesi di atas)
function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}
function parseCookies(req) {
  const out = {};
  const header = req.headers.cookie;
  if (!header) return out;
  for (const pair of header.split(';')) {
    const idx = pair.indexOf('=');
    if (idx === -1) continue;
    out[pair.slice(0, idx).trim()] = decodeURIComponent(pair.slice(idx + 1).trim());
  }
  return out;
}
function getSessionUser(req) {
  const sid = parseCookies(req).sid;
  if (!sid) return null;
  return sessions.get(sid) || null;
}
// Dipakai saat akun dihapus — paksa logout device yang lagi aktif pakai akun itu.
function invalidateSessionsForUser(userId) {
  for (const [sid, s] of sessions) {
    if (s.id === userId) sessions.delete(sid);
  }
}

function createSession(user) {
  // Batasi 1 akun cuma bisa login di 1 perangkat: sesi lama akun ini (kalau ada, dari HP/device lain)
  // langsung dihapus, jadi device lama otomatis "ter-logout" (bakal diminta login ulang).
  for (const [sidLama, s] of sessions) {
    if (s.id === user.id) sessions.delete(sidLama);
  }
  const sid = crypto.randomBytes(24).toString('hex');
  sessions.set(sid, { id: user.id, username: user.username, role: user.role });
  return sid;
}
function setSessionCookie(res, sid) {
  res.setHeader('Set-Cookie', `sid=${sid}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${SESSION_MAX_AGE}`);
}
function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `sid=deleted; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`);
}
// Halaman utama tiap akun: admin ke /admin, guru ke /scan (mode Pemberi/Penarik/Scan Khusus dipilih di halaman scan)
function homeOf(user) {
  if (user.role === 'admin') return '/admin';
  return '/scan';
}
// Cek sesi login & perannya untuk lindungi sebuah halaman. Kalau tidak lolos, otomatis redirect & return null.
function requireRole(req, res, allowedRoles) {
  const user = getSessionUser(req);
  if (!user) { res.writeHead(302, { Location: '/login' }); res.end(); return null; }
  if (!allowedRoles.includes(user.role)) {
    const home = homeOf(user);
    res.writeHead(302, { Location: home }); res.end(); return null;
  }
  return user;
}
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg',
  '.webm': 'audio/webm',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.wav': 'audio/wav',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};
function serveStatic(req, res, filePath) {
  fs.readFile(filePath, (err, content) => {
    if (err) { sendJSON(res, 404, { ok: false, pesan: 'Halaman tidak ditemukan' }); return; }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(content);
  });
}

// ================= LOGIKA UTAMA =================
function jamSejak(tsLalu) {
  if (!tsLalu) return Infinity;
  return (Date.now() - tsLalu) / (1000 * 60 * 60);
}

// Simpan/baca konfigurasi audio kustom (rekaman suara sukses/gagal) di file JSON kecil,
// mirip pola config.json — gak perlu tabel database khusus buat ini.
const AUDIO_DIR = path.join(PUBLIC_DIR, 'audio');
const AUDIO_META_PATH = path.join(AUDIO_DIR, 'meta.json');
function bacaMetaAudio() {
  try { return JSON.parse(fs.readFileSync(AUDIO_META_PATH, 'utf-8')); }
  catch (e) { return {}; }
}
function tulisMetaAudio(meta) {
  if (!fs.existsSync(AUDIO_DIR)) fs.mkdirSync(AUDIO_DIR, { recursive: true });
  fs.writeFileSync(AUDIO_META_PATH, JSON.stringify(meta));
}
const EKSTENSI_DARI_MIME = {
  'audio/webm': 'webm', 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3',
  'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/ogg': 'ogg', 'audio/wav': 'wav', 'audio/wave': 'wav',
};
function simpanAudioKustom(jenis, base64Data, mime) {
  const ext = EKSTENSI_DARI_MIME[mime] || 'webm';
  if (!fs.existsSync(AUDIO_DIR)) fs.mkdirSync(AUDIO_DIR, { recursive: true });
  const namaFile = `notif-${jenis}.${ext}`;
  fs.writeFileSync(path.join(AUDIO_DIR, namaFile), Buffer.from(base64Data, 'base64'));
  const meta = bacaMetaAudio();
  meta[jenis] = namaFile;
  tulisMetaAudio(meta);
}
function hapusAudioKustom(jenis) {
  const meta = bacaMetaAudio();
  const namaFile = meta[jenis];
  if (namaFile) {
    try { fs.unlinkSync(path.join(AUDIO_DIR, namaFile)); } catch (e) { /* file mungkin sudah tidak ada, aman diabaikan */ }
    delete meta[jenis];
    tulisMetaAudio(meta);
  }
}

// Simpan/baca gambar background halaman Welcome (desktop & mobile terpisah), pola sama seperti audio kustom
const WELCOME_BG_DIR = path.join(PUBLIC_DIR, 'welcome-bg');
const WELCOME_BG_META_PATH = path.join(WELCOME_BG_DIR, 'meta.json');
function bacaMetaWelcomeBg() {
  try { return JSON.parse(fs.readFileSync(WELCOME_BG_META_PATH, 'utf-8')); }
  catch (e) { return {}; }
}
function tulisMetaWelcomeBg(meta) {
  if (!fs.existsSync(WELCOME_BG_DIR)) fs.mkdirSync(WELCOME_BG_DIR, { recursive: true });
  fs.writeFileSync(WELCOME_BG_META_PATH, JSON.stringify(meta));
}
const EKSTENSI_GAMBAR_DARI_MIME = {
  'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/webp': 'webp',
};
function simpanWelcomeBg(jenis, base64Data, mime) {
  const ext = EKSTENSI_GAMBAR_DARI_MIME[mime] || 'jpg';
  if (!fs.existsSync(WELCOME_BG_DIR)) fs.mkdirSync(WELCOME_BG_DIR, { recursive: true });
  const namaFile = `bg-${jenis}.${ext}`;
  fs.writeFileSync(path.join(WELCOME_BG_DIR, namaFile), Buffer.from(base64Data, 'base64'));
  const meta = bacaMetaWelcomeBg();
  meta[jenis] = namaFile;
  tulisMetaWelcomeBg(meta);
}
function hapusWelcomeBg(jenis) {
  const meta = bacaMetaWelcomeBg();
  const namaFile = meta[jenis];
  if (namaFile) {
    try { fs.unlinkSync(path.join(WELCOME_BG_DIR, namaFile)); } catch (e) { /* aman diabaikan */ }
    delete meta[jenis];
    tulisMetaWelcomeBg(meta);
  }
}

// Ekstrak nama jurusan otomatis dari teks kelas, misal:
// "XII RPL" -> "RPL", "XI IPA 2" -> "IPA", "XI TKR 1" -> "TKR", "X-1" -> "Umum" (gak ada jurusan spesifik)
// Caranya: buang token tingkat (X/XI/XII) dan token angka urut, sisanya dianggap nama jurusan.
function ekstrakJurusan(kelas) {
  if (!kelas) return 'Umum';
  const tokens = kelas.split(/[\s\-_]+/).filter(Boolean);
  const sisa = tokens.filter((t) => !/^(X|IX|XI|XII|VII|VIII)$/i.test(t) && !/^\d+$/.test(t));
  const jurusan = sisa.join(' ').trim().toUpperCase();
  return jurusan || 'Umum';
}

// ================= RIWAYAT SHOLAT (Orang Tua / Wali Kelas) =================
const NAMA_HARI_ID = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];

// Daftar tanggal Senin–Sabtu dalam rentang (Minggu libur), tidak melewati hari ini, maksimal 366 hari.
function rentangHariSekolah(dari, sampai) {
  const hariIni = todayStr();
  if (sampai > hariIni) sampai = hariIni;
  const out = [];
  if (dari > sampai) return out;
  const [y, m, d] = dari.split('-').map(Number);
  for (let i = 0; i < 366; i++) {
    const t = new Date(Date.UTC(y, m - 1, d + i));
    const str = t.toISOString().slice(0, 10);
    if (str > sampai) break;
    if (t.getUTCDay() !== 0) out.push(str);
  }
  return out;
}
function bacaRentang(url) {
  const hariIni = todayStr();
  let dari = url.searchParams.get('dari');
  let sampai = url.searchParams.get('sampai');
  if (!tanggalValid(sampai)) sampai = hariIni;
  if (!tanggalValid(dari)) dari = hariIni.slice(0, 8) + '01'; // default: awal bulan ini
  if (dari > sampai) [dari, sampai] = [sampai, dari];
  return { dari, sampai };
}
function ringkasRiwayat(sholat, izin, belum) {
  const penyebut = sholat + belum; // izin tidak dihitung bolos maupun hadir
  return { sholat, izin, belum, persen: penyebut > 0 ? Math.round((sholat / penyebut) * 1000) / 10 : null };
}

// Catatan privasi: halaman ini sengaja HANYA menampilkan "izin" tanpa alasan/keterangan (termasuk haid),
// karena dipakai orang tua & untuk laporan/rapor.
async function riwayatSiswa(siswa, dari, sampai) {
  if (siswa.agama === 'non_muslim') return { siswa: { nama: siswa.nama, kelas: siswa.kelas }, non_muslim: true, dari, sampai, hari: [], ringkas: ringkasRiwayat(0, 0, 0), hariAktif: 0 };
  const tanggal = rentangHariSekolah(dari, sampai);
  const aktif = new Set((await stmt.tanggalAktif(dari, sampai)).map((r) => r.tanggal));
  const peta = {};
  (await stmt.absensiSiswaRange(siswa.kts_id, dari, sampai)).forEach((r) => { peta[r.tanggal] = r; });
  let sholat = 0, izin = 0, belum = 0;
  const hari = tanggal.map((t) => {
    const rec = peta[t];
    let status = 'libur';
    if (rec && (rec.status === 'sudah_sholat' || rec.status === 'sudah_pulang')) { status = 'sholat'; sholat++; }
    else if (rec && rec.status === 'izin') { status = 'izin'; izin++; }
    else if (aktif.has(t)) { status = 'belum'; belum++; }
    const [y, m, d] = t.split('-').map(Number);
    return { tanggal: t, hari: NAMA_HARI_ID[new Date(Date.UTC(y, m - 1, d)).getUTCDay()], status, waktu: rec && status === 'sholat' ? rec.waktu_token : null };
  });
  return { siswa: { nama: siswa.nama, kelas: siswa.kelas }, non_muslim: false, dari, sampai, hari, ringkas: ringkasRiwayat(sholat, izin, belum), hariAktif: tanggal.filter((t) => aktif.has(t)).length };
}

// Pembatas request untuk endpoint publik (cegah orang menebak NISN satu per satu): 40 permintaan / 10 menit / IP
const batasPublik = new Map();
function lolosBatasPublik(req) {
  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '?';
  const now = Date.now();
  if (batasPublik.size > 5000) batasPublik.clear();
  let e = batasPublik.get(ip);
  if (!e || now > e.reset) { e = { n: 0, reset: now + 10 * 60 * 1000 }; batasPublik.set(ip, e); }
  e.n++;
  return e.n <= 40;
}

// ================= LOGIKA HAID =================
const BATAS_HAID_HARI = 7; // peringatan muncul mulai hari ke-8 (hari kalender, Minggu tetap dihitung)

function selisihHari(dari, sampai) {
  const [y1, m1, d1] = dari.split('-').map(Number);
  const [y2, m2, d2] = sampai.split('-').map(Number);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86400000);
}
function hariKeHaid(mulai, tanggal) { return selisihHari(mulai, tanggal) + 1; } // H1 = hari ke-1
function tanggalValid(t) { return typeof t === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(t) && !Number.isNaN(Date.parse(t)); }

function normalJK(v) {
  const t = String(v || '').trim().toLowerCase();
  if (!t) return null;
  if (t[0] === 'l') return 'L';                       // L, LK, laki-laki
  if (t[0] === 'p' || t[0] === 'w') return 'P';       // P, PR, perempuan, putri, wanita
  return null;
}

// Info haid satu siswi: episode yang sedang berjalan + siklus sebelumnya (jarak H1 ke H1)
async function infoHaid(kts_id, mulaiBaru) {
  const ep = await stmt.getEpisodeAktif(kts_id);
  const mulai = mulaiBaru || (ep ? ep.tanggal_mulai : null);
  const sebelumnya = await stmt.getEpisodeSebelumnya(kts_id, ep ? ep.id : 0);
  let siklus = null;
  if (mulai && sebelumnya) siklus = { mulai_sebelumnya: sebelumnya.tanggal_mulai, hari: selisihHari(sebelumnya.tanggal_mulai, mulai) };
  return { episode: ep, mulai, siklus };
}

// Dipanggil saat siswi mendapat token sholat NORMAL — artinya haidnya sudah selesai, episode ditutup.
async function tutupEpisodeHaidJikaAda(kts_id) {
  const ep = await stmt.getEpisodeAktif(kts_id);
  if (!ep) return;
  const akhir = (await stmt.hariHaidTerakhir(kts_id)) || ep.tanggal_mulai;
  await stmt.tutupEpisode(ep.id, akhir < ep.tanggal_mulai ? ep.tanggal_mulai : akhir);
}

async function beriTokenSholat(kts_id) {
  const siswa = await cariSiswaGabungan(kts_id);
  if (!siswa) return { ok: false, code: 'not_found', pesan: 'Kartu tidak terdaftar di sistem' };

  if (siswa.agama === 'non_muslim') {
    // Non-muslim tidak perlu absen sholat — kasih info doang, tidak dicatat ke tabel absensi
    return { ok: true, info: true, siswa, pesan: 'Siswa non-muslim terdaftar — tidak perlu token sholat' };
  }

  const tanggal = todayStr();
  const existing = await stmt.getAbsensi(kts_id, tanggal);
  const now = Date.now();
  const waktu = nowStr();

  // Siswi yang sholat normal = haid selesai (kecuali hari ini sendiri dicatat izin/haid)
  if (!(existing && existing.status === 'izin')) await tutupEpisodeHaidJikaAda(kts_id);

  if (existing) {
    if (existing.status === 'belum') {
      await stmt.updateJadiSholat(waktu, now, existing.id);
      return { ok: true, siswa, waktu, pesan: 'Token sholat diberikan' };
    }
    if (existing.status === 'sudah_pulang') {
      // Kartu sudah pernah keluar hari ini, tapi tetap boleh dikasih token baru
      // (misal: guru salah scan di gerbang, atau siswa keluar-masuk lagi)
      await stmt.updateJadiSholat(waktu, now, existing.id);
      return { ok: true, siswa, waktu, diperbarui: true, pesan: 'Token baru diberikan (kartu ini sebelumnya sudah pernah keluar)' };
    }
    if (existing.status === 'sudah_sholat' && jamSejak(existing.token_ts) >= config.tokenValidHours) {
      // Token lama sudah kadaluarsa, boleh diberi token baru
      await stmt.updateJadiSholat(waktu, now, existing.id);
      return { ok: true, siswa, waktu, diperbarui: true, pesan: 'Token diperbarui (token sebelumnya sudah kadaluarsa)' };
    }
    return { ok: true, sudahAda: true, siswa, waktu: existing.waktu_token, pesan: 'Sudah dapat token sebelumnya hari ini' };
  }

  await stmt.insertAbsensi(kts_id, tanggal, waktu, now);
  return { ok: true, siswa, waktu, pesan: 'Token sholat diberikan' };
}

async function verifikasiKeluar(kts_id) {
  const siswa = await cariSiswaGabungan(kts_id);
  if (!siswa) return { ok: false, code: 'not_found', pesan: 'Kartu tidak terdaftar di sistem' };

  const tanggal = todayStr();
  const existing = await stmt.getAbsensi(kts_id, tanggal);

  if (siswa.agama === 'non_muslim') {
    // Non-muslim langsung boleh pulang tanpa perlu token sholat dulu.
    // Tetap dicatat ke rekap (biar kelihatan statusnya "sudah pulang"), dan tetap dicegah discan 2x.
    if (existing && existing.status === 'sudah_pulang') {
      return { ok: false, code: 'sudah_keluar', siswa, waktu: existing.waktu_keluar, pesan: 'Kartu ini sudah discan keluar sebelumnya' };
    }
    const waktu = nowStr();
    if (existing) {
      await stmt.updateJadiPulang(waktu, existing.id);
    } else {
      await stmt.insertAbsensi(kts_id, tanggal, null, null);
      const baru = await stmt.getAbsensi(kts_id, tanggal);
      await stmt.updateJadiPulang(waktu, baru.id);
    }
    return { ok: true, siswa, waktu, pesan: 'Boleh pulang (non-muslim, tidak perlu token)' };
  }

  if (existing && existing.status === 'izin') {
    // Siswa berhalangan (sakit/haid/izin) yang sudah diberi token khusus oleh Scan Khusus — boleh langsung pulang.
    const waktu = nowStr();
    await stmt.updateJadiPulang(waktu, existing.id);
    return { ok: true, siswa, waktu, izin: true, keterangan: existing.keterangan, pesan: `Boleh pulang (izin: ${existing.keterangan || '-'})` };
  }
  if (!existing || existing.status === 'belum') {
    return { ok: false, code: 'belum_sholat', siswa, pesan: 'Belum melaksanakan sholat — tidak boleh pulang' };
  }
  if (existing.status === 'sudah_pulang') {
    return { ok: false, code: 'sudah_keluar', siswa, waktu: existing.waktu_keluar, pesan: 'Kartu ini sudah discan keluar sebelumnya' };
  }
  if (jamSejak(existing.token_ts) >= config.tokenValidHours) {
    return { ok: false, code: 'token_kadaluarsa', siswa, pesan: `Token sudah kadaluarsa (lebih dari ${config.tokenValidHours} jam) — minta token sholat lagi` };
  }

  const waktu = nowStr();
  await stmt.updateJadiPulang(waktu, existing.id);
  return { ok: true, siswa, waktu, pesan: 'Boleh pulang' };
}

function detectDelimiter(line) {
  const counts = {
    '\t': (line.match(/\t/g) || []).length,
    ';': (line.match(/;/g) || []).length,
    ',': (line.match(/,/g) || []).length,
  };
  let best = ',', bestCount = -1;
  for (const [d, c] of Object.entries(counts)) {
    if (c > bestCount) { bestCount = c; best = d; }
  }
  return best;
}

async function importSiswaCSV(csvText) {
  const lines = csvText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return { masuk: 0, gagal: [] };
  const delim = detectDelimiter(lines[0]);
  let masuk = 0;
  const gagal = [];
  for (const line of lines) {
    const lower = line.toLowerCase();
    if (lower.startsWith('kts_id') || lower.startsWith('kts') || lower.startsWith('nomor')) continue; // lewati header
    const parts = line.split(delim).map((p) => p.trim());
    if (parts.length < 2 || !parts[0] || !parts[1]) { gagal.push(line); continue; }
    const [kts_id, nama, kelas = '', jkRaw = ''] = parts;
    await stmt.addSiswa(kts_id, nama, kelas, normalJK(jkRaw));
    masuk++;
  }
  return { masuk, gagal };
}

// ================= ROUTER =================
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;

  try {
    // ---- Halaman ----
    if (req.method === 'GET' && p === '/login') return serveStatic(req, res, path.join(PUBLIC_DIR, 'login.html'));
    if (req.method === 'GET' && p === '/orangtua') return serveStatic(req, res, path.join(PUBLIC_DIR, 'orangtua.html'));
    if (req.method === 'GET' && p === '/') {
      const user = getSessionUser(req);
      if (!user) return serveStatic(req, res, path.join(PUBLIC_DIR, 'welcome.html'));
      const home = homeOf(user);
      res.writeHead(302, { Location: home }); return res.end();
    }
    if (req.method === 'GET' && p === '/scan') {
      if (!requireRole(req, res, ['guru', 'admin'])) return;
      return serveStatic(req, res, path.join(PUBLIC_DIR, 'scan.html'));
    }
    // Link lama (/guru, /gerbang) diarahkan ke halaman scan dengan mode yang sesuai
    if (req.method === 'GET' && (p === '/guru' || p === '/gerbang')) {
      res.writeHead(302, { Location: '/scan?mode=' + (p === '/guru' ? 'pemberi' : 'penarik') }); return res.end();
    }
    if (req.method === 'GET' && p === '/admin') {
      if (!requireRole(req, res, ['admin'])) return;
      return serveStatic(req, res, path.join(PUBLIC_DIR, 'admin.html'));
    }
    if (req.method === 'GET' && p === '/cetak-kartu') {
      if (!requireRole(req, res, ['admin'])) return;
      return serveStatic(req, res, path.join(PUBLIC_DIR, 'cetak-kartu.html'));
    }
    if (req.method === 'GET' && p === '/riwayat') {
      if (!requireRole(req, res, ['admin'])) return;
      return serveStatic(req, res, path.join(PUBLIC_DIR, 'riwayat.html'));
    }
    if (req.method === 'GET' && p === '/siswa') {
      if (!requireRole(req, res, ['admin'])) return;
      return serveStatic(req, res, path.join(PUBLIC_DIR, 'siswa.html'));
    }
    if (req.method === 'GET' && p === '/rekap') {
      if (!requireRole(req, res, ['admin'])) return;
      return serveStatic(req, res, path.join(PUBLIC_DIR, 'rekap.html'));
    }
    if (req.method === 'GET' && p === '/rekap-mingguan') {
      res.writeHead(302, { Location: '/rekap' });
      return res.end();
    }
    if (req.method === 'GET' && p === '/akun-guru') {
      if (!requireRole(req, res, ['admin'])) return;
      return serveStatic(req, res, path.join(PUBLIC_DIR, 'akun-guru.html'));
    }
    if (req.method === 'GET' && p === '/scan-khusus') {
      // Halaman lama dihapus — Scan Khusus sekarang jadi salah satu mode di halaman /scan (akun guru).
      res.writeHead(302, { Location: '/scan?mode=khusus' });
      return res.end();
    }

    // ---- API: login & logout ----
    if (req.method === 'POST' && p === '/api/login') {
      const body = await readBody(req);
      const username = String(body.username || '').trim();
      const password = String(body.password || '');
      if (!username || !password) return sendJSON(res, 400, { ok: false, pesan: 'Username dan password wajib diisi' });
      const user = await stmt.getUserByUsername(username);
      if (!user) return sendJSON(res, 401, { ok: false, pesan: 'Username atau password salah' });
      const cocok = hashPassword(password, user.salt) === user.password_hash
        || (password.trim() !== password && hashPassword(password.trim(), user.salt) === user.password_hash)
        || hashPassword(password.trim() + ' ', user.salt) === user.password_hash; // akun lama yang passwordnya tersimpan dengan 1 spasi di ujung
      if (!cocok) {
        return sendJSON(res, 401, { ok: false, pesan: 'Username atau password salah' });
      }
      const sid = createSession(user);
      setSessionCookie(res, sid);
      const home = homeOf(user);
      return sendJSON(res, 200, { ok: true, role: user.role, redirect: home });
    }
    if (req.method === 'POST' && p === '/api/logout') {
      const sid = parseCookies(req).sid;
      if (sid) sessions.delete(sid);
      clearSessionCookie(res);
      return sendJSON(res, 200, { ok: true });
    }

    // ---- File statis lain (css/js/audio kustom) ----
    if (req.method === 'GET' && /\.(css|js|svg|png|ico|mp3|webm|ogg|m4a|wav|jpg|jpeg|webp)$/.test(p)) {
      const filePath = path.join(PUBLIC_DIR, p);
      if (filePath.startsWith(PUBLIC_DIR)) return serveStatic(req, res, filePath);
    }

    // ---- API: status audio kustom (bisa diakses siapa saja yang sudah login, bukan cuma admin) ----
    if (req.method === 'GET' && p === '/api/audio/status') {
      if (!getSessionUser(req)) return sendJSON(res, 401, { ok: false, pesan: 'Harus login' });
      const meta = bacaMetaAudio();
      return sendJSON(res, 200, {
        ok: true,
        sukses: meta.sukses ? `/audio/${meta.sukses}` : null,
        gagal: meta.gagal ? `/audio/${meta.gagal}` : null,
      });
    }

    // ---- API: status background welcome (PUBLIK, dipakai di halaman sebelum login) ----
    if (req.method === 'GET' && p === '/api/welcome-bg/status') {
      const meta = bacaMetaWelcomeBg();
      return sendJSON(res, 200, {
        ok: true,
        desktop: meta.desktop ? `/welcome-bg/${meta.desktop}` : null,
        mobile: meta.mobile ? `/welcome-bg/${meta.mobile}` : null,
      });
    }

    // ---- API: beri token sholat ----
    if (req.method === 'POST' && p === '/api/token') {
      const user = getSessionUser(req);
      if (!user) return sendJSON(res, 401, { ok: false, pesan: 'Harus login' });
      const cekJadwal = await cekJadwalPiket(user);
      if (!cekJadwal.ok) return sendJSON(res, 403, { ok: false, code: 'bukan_jadwal', pesan: cekJadwal.pesan });
      const body = await readBody(req);
      if (!body.kts_id) return sendJSON(res, 400, { ok: false, pesan: 'kts_id wajib diisi' });
      return sendJSON(res, 200, await beriTokenSholat(String(body.kts_id).trim()));
    }

    // ---- API: verifikasi & tarik token di gerbang ----
    if (req.method === 'POST' && p === '/api/verify') {
      const user = getSessionUser(req);
      if (!user) return sendJSON(res, 401, { ok: false, pesan: 'Harus login' });
      const cekJadwal = await cekJadwalPiket(user);
      if (!cekJadwal.ok) return sendJSON(res, 403, { ok: false, code: 'bukan_jadwal', pesan: cekJadwal.pesan });
      const body = await readBody(req);
      if (!body.kts_id) return sendJSON(res, 400, { ok: false, pesan: 'kts_id wajib diisi' });
      return sendJSON(res, 200, await verifikasiKeluar(String(body.kts_id).trim()));
    }

    // ---- API: info haid satu siswa (dipakai halaman Scan Khusus: tampilkan/sembunyikan tombol Haid + status episode) ----
    if (req.method === 'GET' && p === '/api/haid/info') {
      const user = getSessionUser(req);
      if (!user || !['guru', 'admin', 'scan_khusus'].includes(user.role)) return sendJSON(res, 401, { ok: false, pesan: 'Harus login' });
      const kts_id = String(url.searchParams.get('kts_id') || '').trim();
      const siswa = await cariSiswaGabungan(kts_id);
      if (!siswa) return sendJSON(res, 200, { ok: false, code: 'not_found', pesan: 'Kartu tidak terdaftar di sistem' });
      const boleh = siswa.sumber === 'utama' && siswa.jenis_kelamin === 'P';
      const { episode } = await infoHaid(kts_id);
      return sendJSON(res, 200, {
        ok: true, siswa: { nama: siswa.nama, kelas: siswa.kelas }, jenis_kelamin: siswa.jenis_kelamin || null, boleh_haid: boleh,
        episode: episode ? { mulai: episode.tanggal_mulai, hari_ke: hariKeHaid(episode.tanggal_mulai, todayStr()), diselidiki: !!episode.diselidiki } : null,
        batas: BATAS_HAID_HARI,
      });
    }

    // ---- API: Scan Khusus — beri token ke siswa berhalangan (sakit/haid/izin/dll), keterangan diketik manual ----
    if (req.method === 'POST' && p === '/api/token-khusus') {
      const user = getSessionUser(req);
      if (!user || !['guru', 'admin', 'scan_khusus'].includes(user.role)) return sendJSON(res, 401, { ok: false, pesan: 'Harus login sebagai Guru atau Admin' });
      const body = await readBody(req);
      const kts_id = String(body.kts_id || '').trim();
      let keterangan = String(body.keterangan || '').trim();
      const jenis = ['haid', 'sakit', 'izin'].includes(body.jenis) ? body.jenis : 'lain';
      if (!kts_id) return sendJSON(res, 400, { ok: false, pesan: 'Nomor kartu wajib diisi' });
      const siswa = await cariSiswaGabungan(kts_id);
      if (!siswa) return sendJSON(res, 200, { ok: false, code: 'not_found', pesan: 'Kartu tidak terdaftar di sistem' });
      const tanggal = todayStr();
      const waktu = nowStr();

      if (jenis !== 'haid') {
        if (!keterangan) return sendJSON(res, 400, { ok: false, pesan: 'Keterangan alasan wajib diisi' });
        await stmt.insertOrUpdateIzin(kts_id, tanggal, waktu, Date.now(), keterangan, jenis);
        return sendJSON(res, 200, { ok: true, siswa, waktu, keterangan, pesan: `Token izin diberikan (${keterangan})` });
      }

      // ---- jenis HAID ----
      if (siswa.sumber !== 'utama') return sendJSON(res, 200, { ok: false, code: 'bukan_putri', pesan: 'Kartu sementara tidak bisa dicatat haid' });
      if (!siswa.jenis_kelamin) return sendJSON(res, 200, { ok: false, code: 'bukan_putri', pesan: 'Jenis kelamin siswa belum diisi — isi dulu di halaman Data Siswa' });
      if (siswa.jenis_kelamin !== 'P') return sendJSON(res, 200, { ok: false, code: 'bukan_putri', pesan: 'Siswa ini laki-laki, tidak bisa dicatat haid' });

      let mulaiSejak = tanggalValid(body.mulai_sejak) ? body.mulai_sejak : null;
      if (mulaiSejak && mulaiSejak > tanggal) mulaiSejak = null; // tidak boleh tanggal masa depan
      const { episode, mulai: mulaiLama } = await infoHaid(kts_id);
      const mulai = mulaiSejak || mulaiLama || tanggal;      // H1: dikoreksi guru > H1 lama > hari ini (scan haid pertama)
      const hariKe = hariKeHaid(mulai, tanggal);
      const lewatBatas = hariKe > BATAS_HAID_HARI;
      const konfirmasi = ['lanjut', 'tidak'].includes(body.konfirmasi) ? body.konfirmasi : null;

      if (lewatBatas && !konfirmasi) {
        const { siklus } = await infoHaid(kts_id, mulai);
        return sendJSON(res, 200, {
          ok: false, code: 'peringatan_haid', siswa, hari_ke: hariKe, mulai, batas: BATAS_HAID_HARI, siklus,
          diselidiki: episode ? !!episode.diselidiki : false,
          pesan: `Haid sudah hari ke-${hariKe}, lebih lama dari biasanya (lebih dari ${BATAS_HAID_HARI} hari)`,
        });
      }
      if (lewatBatas && !keterangan) return sendJSON(res, 400, { ok: false, pesan: 'Keterangan wajib diisi saat haid melewati batas hari' });

      // simpan / koreksi episode
      let ep = episode;
      if (!ep) { await stmt.mulaiEpisode(kts_id, mulai); ep = await stmt.getEpisodeAktif(kts_id); }
      else if (ep.tanggal_mulai !== mulai) await stmt.ubahMulaiEpisode(ep.id, mulai);

      if (lewatBatas) {
        const aksi = konfirmasi === 'lanjut' ? 'Lanjut beri token' : 'TIDAK diberi token (diselidiki)';
        await stmt.catatEpisode(ep.id, `${tanggal} (hari ke-${hariKe}): ${aksi} — ${keterangan}\n`, konfirmasi === 'tidak');
        if (konfirmasi === 'tidak') {
          return sendJSON(res, 200, { ok: true, ditahan: true, siswa, hari_ke: hariKe, mulai, pesan: 'Token TIDAK diberikan — ditandai untuk diselidiki' });
        }
      }

      const teks = `Haid hari ke-${hariKe}` + (keterangan ? ` — ${keterangan}` : '');
      await stmt.insertOrUpdateIzin(kts_id, tanggal, waktu, Date.now(), teks.slice(0, 255), 'haid');
      return sendJSON(res, 200, { ok: true, siswa, waktu, keterangan: teks, hari_ke: hariKe, mulai, pesan: `Token izin diberikan (${teks})` });
    }

    // ---- API publik: riwayat sholat 1 siswa lewat NISN (Orang Tua / Murid) ----
    if (req.method === 'GET' && p === '/api/publik/riwayat') {
      if (!lolosBatasPublik(req)) return sendJSON(res, 429, { ok: false, pesan: 'Terlalu banyak pencarian. Coba lagi beberapa menit lagi.' });
      const nisn = String(url.searchParams.get('nisn') || '').trim();
      if (!nisn) return sendJSON(res, 400, { ok: false, pesan: 'Isi NISN dulu' });
      const siswa = await stmt.getSiswa(nisn);
      if (!siswa) return sendJSON(res, 200, { ok: false, code: 'not_found', pesan: 'NISN tidak ditemukan. Periksa lagi nomornya.' });
      const { dari, sampai } = bacaRentang(url);
      return sendJSON(res, 200, { ok: true, ...(await riwayatSiswa(siswa, dari, sampai)) });
    }

    // ---- API Wali Kelas (butuh login guru/admin): rekap 1 kelas & detail 1 siswa ----
    if (p.startsWith('/api/walas/')) {
      const user = getSessionUser(req);
      if (!user || !['guru', 'admin', 'scan_khusus'].includes(user.role)) return sendJSON(res, 401, { ok: false, code: 'perlu_login', pesan: 'Login sebagai guru dulu' });
      if (req.method === 'GET' && p === '/api/walas/kelas') {
        return sendJSON(res, 200, { ok: true, data: (await stmt.daftarKelas()).map((r) => r.kelas) });
      }
      if (req.method === 'GET' && p === '/api/walas/siswa') {
        const siswa = await stmt.getSiswa(String(url.searchParams.get('kts_id') || '').trim());
        if (!siswa) return sendJSON(res, 200, { ok: false, pesan: 'Siswa tidak ditemukan' });
        const { dari, sampai } = bacaRentang(url);
        return sendJSON(res, 200, { ok: true, ...(await riwayatSiswa(siswa, dari, sampai)) });
      }
      if (req.method === 'GET' && p === '/api/walas/rekap') {
        const kelas = String(url.searchParams.get('kelas') || '').trim();
        if (!kelas) return sendJSON(res, 400, { ok: false, pesan: 'Pilih kelas dulu' });
        const { dari, sampai } = bacaRentang(url);
        const tanggal = rentangHariSekolah(dari, sampai);
        const aktif = new Set((await stmt.tanggalAktif(dari, sampai)).map((r) => r.tanggal));
        const tglAktif = tanggal.filter((t) => aktif.has(t));
        const peta = {};
        (await stmt.absensiKelasRange(kelas, dari, sampai)).forEach((r) => { (peta[r.kts_id] = peta[r.kts_id] || {})[r.tanggal] = r.status; });
        const data = (await stmt.siswaPerKelas(kelas)).map((sw) => {
          if (sw.agama === 'non_muslim') return { kts_id: sw.kts_id, nama: sw.nama, non_muslim: true, sholat: 0, izin: 0, belum: 0, persen: null };
          let sholat = 0, izin = 0, belum = 0;
          tglAktif.forEach((t) => {
            const st = peta[sw.kts_id] && peta[sw.kts_id][t];
            if (st === 'sudah_sholat' || st === 'sudah_pulang') sholat++;
            else if (st === 'izin') izin++;
            else belum++;
          });
          return { kts_id: sw.kts_id, nama: sw.nama, non_muslim: false, ...ringkasRiwayat(sholat, izin, belum) };
        });
        return sendJSON(res, 200, { ok: true, kelas, dari, sampai, hariAktif: tglAktif.length, data });
      }
    }

    // ---- API: jadwal piket punya akun yang sedang login (dipakai halaman scan, buat tampilkan info) ----
    if (req.method === 'GET' && p === '/api/jadwal-saya') {
      const user = getSessionUser(req);
      if (!user) return sendJSON(res, 401, { ok: false, pesan: 'Harus login' });
      const rows = await stmt.getJadwal(user.id);
      const hari = rows.map((r) => Number(r.hari));
      return sendJSON(res, 200, { ok: true, hari, hariIni: hariIniAngka() });
    }

    // ---- API: ringkasan angka hari ini (dipakai halaman guru & gerbang) ----
    if (req.method === 'GET' && p === '/api/ringkasan') {
      const tanggal = todayStr();
      const row = await stmt.countStatusHariIni(tanggal);
      const totalSiswa = await stmt.countSiswa();
      return sendJSON(res, 200, {
        ok: true,
        tanggal,
        totalSiswa,
        sudahSholat: row.sudah_sholat || 0,
        sudahPulang: row.sudah_pulang || 0,
        sudahIzin: row.sudah_izin || 0,
      });
    }

    // ---- API ADMIN (butuh sesi login sebagai admin) ----
    if (p.startsWith('/api/siswa') || p === '/api/rekap' || p.startsWith('/api/users') || p.startsWith('/api/jadwal') || p.startsWith('/api/sementara') || p.startsWith('/api/audio') || p.startsWith('/api/riwayat') || p.startsWith('/api/welcome-bg') || p === '/api/haid/berjalan') {
      const admin = getSessionUser(req);
      if (!admin || admin.role !== 'admin') return sendJSON(res, 401, { ok: false, pesan: 'Harus login sebagai admin' });

      if (req.method === 'GET' && p === '/api/haid/berjalan') {
        const hariIni = todayStr();
        const data = (await stmt.listEpisodeBerjalan()).map((e) => ({ ...e, hari_ke: hariKeHaid(e.tanggal_mulai, hariIni), diselidiki: !!e.diselidiki }));
        return sendJSON(res, 200, { ok: true, batas: BATAS_HAID_HARI, data });
      }
      if (req.method === 'GET' && p === '/api/users') {
        return sendJSON(res, 200, { ok: true, data: await stmt.listUsers() });
      }
      if (req.method === 'POST' && p === '/api/users') {
        const body = await readBody(req);
        const username = String(body.username || '').trim();
        const password = String(body.password || '').trim();
        const role = ['guru', 'admin'].includes(body.role) ? body.role : 'guru';
        if (!username || !password) return sendJSON(res, 400, { ok: false, pesan: 'Nama dan password wajib diisi' });
        if (password.length < 4) return sendJSON(res, 400, { ok: false, pesan: 'Password minimal 4 karakter' });
        if (await stmt.getUserByUsername(username)) return sendJSON(res, 400, { ok: false, pesan: 'Nama ini sudah dipakai, pilih nama lain' });
        const salt = crypto.randomBytes(16).toString('hex');
        await stmt.addUser(username, hashPassword(password, salt), salt, role);
        const labelPeran = { guru: 'Guru', admin: 'Admin', scan_khusus: 'Scan Khusus' };
        return sendJSON(res, 200, { ok: true, pesan: `Akun ${labelPeran[role]} berhasil ditambahkan` });
      }
      if (req.method === 'POST' && p === '/api/users/delete') {
        const body = await readBody(req);
        const target = await stmt.getUserById(body.id);
        if (!target) return sendJSON(res, 404, { ok: false, pesan: 'Akun tidak ditemukan' });
        if (target.id === admin.id) return sendJSON(res, 400, { ok: false, pesan: 'Tidak bisa menghapus akun sendiri yang sedang login' });
        if (target.role === 'admin' && (await stmt.countAdmin()) <= 1) {
          return sendJSON(res, 400, { ok: false, pesan: 'Tidak bisa dihapus — minimal harus ada 1 akun admin' });
        }
        await stmt.deleteUser(body.id);
        invalidateSessionsForUser(body.id); // paksa logout device yang lagi pakai akun ini
        return sendJSON(res, 200, { ok: true, pesan: 'Akun dihapus' });
      }
      if (req.method === 'POST' && p === '/api/users/delete-massal') {
        const body = await readBody(req);
        const ids = Array.isArray(body.ids) ? body.ids.map(Number).filter(Number.isInteger) : [];
        let dihapus = 0;
        const dilewati = [];
        for (const id of ids) {
          const target = await stmt.getUserById(id);
          if (!target) continue;
          if (target.id === admin.id) { dilewati.push(target.username + ' (akun sendiri)'); continue; }
          if (target.role === 'admin' && (await stmt.countAdmin()) <= 1) { dilewati.push(target.username + ' (admin terakhir)'); continue; }
          await stmt.deleteUser(id);
          invalidateSessionsForUser(id); // paksa logout device yang lagi pakai akun ini
          dihapus++;
        }
        return sendJSON(res, 200, { ok: true, dihapus, dilewati, pesan: `${dihapus} akun dihapus` + (dilewati.length ? `, ${dilewati.length} dilewati (${dilewati.join(', ')})` : '') });
      }
      if (req.method === 'POST' && p === '/api/users/jadwal') {
        const body = await readBody(req);
        const target = await stmt.getUserById(body.id);
        if (!target) return sendJSON(res, 404, { ok: false, pesan: 'Akun tidak ditemukan' });
        const hariArr = Array.isArray(body.hari) ? body.hari : [];
        const bersih = [...new Set(hariArr.map(Number))].filter((h) => Number.isInteger(h) && h >= 1 && h <= 7);
        await stmt.setJadwal(body.id, bersih);
        return sendJSON(res, 200, { ok: true, pesan: 'Jadwal piket disimpan' });
      }
      if (req.method === 'POST' && p === '/api/users/password') {
        const body = await readBody(req);
        const password = String(body.password || '').trim();
        if (!body.id || !password) return sendJSON(res, 400, { ok: false, pesan: 'id dan password baru wajib diisi' });
        if (password.length < 4) return sendJSON(res, 400, { ok: false, pesan: 'Password minimal 4 karakter' });
        const target = await stmt.getUserById(body.id);
        if (!target) return sendJSON(res, 404, { ok: false, pesan: 'Akun tidak ditemukan' });
        const salt = crypto.randomBytes(16).toString('hex');
        await stmt.updateUserPassword(hashPassword(password, salt), salt, body.id);
        return sendJSON(res, 200, { ok: true, pesan: 'Password diperbarui' });
      }

      if (req.method === 'GET' && p === '/api/siswa') {
        return sendJSON(res, 200, { ok: true, data: await stmt.listSiswa() });
      }
      if (req.method === 'POST' && p === '/api/siswa') {
        const body = await readBody(req);
        if (!body.kts_id || !body.nama) return sendJSON(res, 400, { ok: false, pesan: 'kts_id dan nama wajib diisi' });
        await stmt.addSiswa(String(body.kts_id).trim(), body.nama.trim(), (body.kelas || '').trim(), normalJK(body.jenis_kelamin));
        return sendJSON(res, 200, { ok: true, pesan: 'Siswa ditambahkan' });
      }
      if (req.method === 'POST' && p === '/api/siswa/import') {
        const body = await readBody(req);
        if (!body.csv) return sendJSON(res, 400, { ok: false, pesan: 'Isi csv kosong' });
        const hasil = await importSiswaCSV(body.csv);
        return sendJSON(res, 200, { ok: true, ...hasil });
      }
      if (req.method === 'GET' && p === '/api/rekap') {
        const tanggal = url.searchParams.get('tanggal') || todayStr();
        return sendJSON(res, 200, { ok: true, tanggal, data: await stmt.rekapHariIni(tanggal) });
      }
      if (req.method === 'POST' && p === '/api/siswa/reset') {
        const body = await readBody(req);
        if (!body.kts_id) return sendJSON(res, 400, { ok: false, pesan: 'kts_id wajib diisi' });
        await stmt.resetAbsensiHariIni(String(body.kts_id).trim(), todayStr());
        return sendJSON(res, 200, { ok: true, pesan: 'Status absensi hari ini direset, kartu ini bisa discan dari awal lagi' });
      }
      if (req.method === 'POST' && p === '/api/siswa/agama') {
        const body = await readBody(req);
        if (!body.kts_id || !['muslim', 'non_muslim'].includes(body.agama)) {
          return sendJSON(res, 400, { ok: false, pesan: 'kts_id dan agama (muslim/non_muslim) wajib diisi' });
        }
        await stmt.updateAgamaSiswa(String(body.kts_id).trim(), body.agama);
        return sendJSON(res, 200, { ok: true, pesan: 'Agama siswa diperbarui' });
      }
      if (req.method === 'POST' && p === '/api/siswa/delete') {
        const body = await readBody(req);
        if (!body.kts_id) return sendJSON(res, 400, { ok: false, pesan: 'kts_id wajib diisi' });
        const kts_id = String(body.kts_id).trim();
        await stmt.hapusAbsensiSiswa(kts_id);
        await stmt.hapusSiswa(kts_id);
        return sendJSON(res, 200, { ok: true, pesan: 'Data siswa dihapus permanen (termasuk riwayat absensinya)' });
      }
      if (req.method === 'POST' && p === '/api/siswa/jenis-kelamin') {
        const body = await readBody(req);
        const jk = normalJK(body.jenis_kelamin);
        const ids = Array.isArray(body.kts_ids) ? body.kts_ids.map((x) => String(x).trim()).filter(Boolean) : [];
        if (!jk || !ids.length) return sendJSON(res, 400, { ok: false, pesan: 'Pilih siswa dan jenis kelamin (L/P) dulu' });
        await stmt.setJenisKelamin(ids, jk);
        return sendJSON(res, 200, { ok: true, pesan: `${ids.length} siswa diatur ke ${jk === 'P' ? 'Perempuan' : 'Laki-laki'}` });
      }
      if (req.method === 'POST' && p === '/api/siswa/delete-massal') {
        const body = await readBody(req);
        const daftar = Array.isArray(body.kts_ids) ? body.kts_ids.map((x) => String(x).trim()).filter(Boolean) : [];
        for (const kts_id of daftar) {
          await stmt.hapusAbsensiSiswa(kts_id);
          await stmt.hapusSiswa(kts_id);
        }
        return sendJSON(res, 200, { ok: true, pesan: `${daftar.length} siswa dihapus permanen` });
      }
      if (req.method === 'GET' && p === '/api/siswa-semua') {
        const data = (await stmt.listSiswa()).map((s) => ({ ...s, jurusan: ekstrakJurusan(s.kelas) }));
        return sendJSON(res, 200, { ok: true, data });
      }
      if (req.method === 'POST' && p === '/api/siswa/edit') {
        const body = await readBody(req);
        const kts_id_lama = String(body.kts_id_lama || '').trim();
        const kts_id_baru = String(body.kts_id_baru || '').trim();
        const nama = String(body.nama || '').trim();
        const kelas = String(body.kelas || '').trim();
        if (!kts_id_lama || !kts_id_baru || !nama) return sendJSON(res, 400, { ok: false, pesan: 'NISN dan nama wajib diisi' });
        if (kts_id_baru !== kts_id_lama && (await stmt.getSiswa(kts_id_baru))) {
          return sendJSON(res, 400, { ok: false, pesan: 'NISN baru sudah dipakai siswa lain' });
        }
        await stmt.editSiswa(kts_id_lama, kts_id_baru, nama, kelas, normalJK(body.jenis_kelamin));
        return sendJSON(res, 200, { ok: true, pesan: 'Data siswa diperbarui' });
      }

      // ---- Kartu Sementara (kode 001-700, bisa terus ditambah) ----
      if (req.method === 'GET' && p === '/api/sementara') {
        return sendJSON(res, 200, { ok: true, data: await stmt.listSementara() });
      }
      if (req.method === 'POST' && p === '/api/sementara/agama') {
        const body = await readBody(req);
        if (!body.kode || !['muslim', 'non_muslim'].includes(body.agama)) {
          return sendJSON(res, 400, { ok: false, pesan: 'kode dan agama (muslim/non_muslim) wajib diisi' });
        }
        await stmt.updateAgamaSementara(String(body.kode).trim(), body.agama);
        return sendJSON(res, 200, { ok: true, pesan: 'Agama kartu sementara diperbarui' });
      }
      if (req.method === 'POST' && p === '/api/sementara/aktif') {
        const body = await readBody(req);
        if (!body.kode || typeof body.aktif !== 'boolean') {
          return sendJSON(res, 400, { ok: false, pesan: 'kode dan aktif (true/false) wajib diisi' });
        }
        await stmt.updateAktifSementara(String(body.kode).trim(), body.aktif);
        return sendJSON(res, 200, { ok: true, pesan: body.aktif ? 'Kartu diaktifkan' : 'Kartu dinonaktifkan' });
      }
      if (req.method === 'POST' && p === '/api/sementara/aktif-semua') {
        const body = await readBody(req);
        if (typeof body.aktif !== 'boolean') return sendJSON(res, 400, { ok: false, pesan: 'aktif (true/false) wajib diisi' });
        await stmt.aktifkanSemuaSementara(body.aktif);
        return sendJSON(res, 200, { ok: true, pesan: body.aktif ? 'Semua kartu sementara diaktifkan' : 'Semua kartu sementara dinonaktifkan sekaligus' });
      }
      if (req.method === 'POST' && p === '/api/sementara/tambah') {
        const body = await readBody(req);
        const jumlah = parseInt(body.jumlah, 10);
        if (!jumlah || jumlah < 1 || jumlah > 500) {
          return sendJSON(res, 400, { ok: false, pesan: 'Jumlah harus angka 1-500' });
        }
        const kodeBaru = await tambahKartuSementaraBaru(jumlah);
        return sendJSON(res, 200, { ok: true, pesan: `${jumlah} kartu baru dibuat (${kodeBaru[0]} s/d ${kodeBaru[kodeBaru.length - 1]})`, kodeBaru });
      }

      // ---- Audio notifikasi kustom (rekaman suara sendiri, menggantikan bunyi default) ----
      if (req.method === 'POST' && p === '/api/audio') {
        const body = await readBody(req);
        if (!body.jenis || !['sukses', 'gagal'].includes(body.jenis) || !body.data || !body.mime) {
          return sendJSON(res, 400, { ok: false, pesan: 'jenis (sukses/gagal), data, dan mime wajib diisi' });
        }
        simpanAudioKustom(body.jenis, body.data, body.mime);
        return sendJSON(res, 200, { ok: true, pesan: 'Audio kustom disimpan' });
      }
      if (req.method === 'POST' && p === '/api/audio/hapus') {
        const body = await readBody(req);
        if (!body.jenis || !['sukses', 'gagal'].includes(body.jenis)) {
          return sendJSON(res, 400, { ok: false, pesan: 'jenis (sukses/gagal) wajib diisi' });
        }
        hapusAudioKustom(body.jenis);
        return sendJSON(res, 200, { ok: true, pesan: 'Audio kustom dihapus, kembali ke bunyi default' });
      }

      // ---- Background halaman Welcome (desktop & mobile) ----
      if (req.method === 'POST' && p === '/api/welcome-bg') {
        const body = await readBody(req);
        if (!body.jenis || !['desktop', 'mobile'].includes(body.jenis) || !body.data || !body.mime) {
          return sendJSON(res, 400, { ok: false, pesan: 'jenis (desktop/mobile), data, dan mime wajib diisi' });
        }
        simpanWelcomeBg(body.jenis, body.data, body.mime);
        return sendJSON(res, 200, { ok: true, pesan: 'Gambar background disimpan' });
      }
      if (req.method === 'POST' && p === '/api/welcome-bg/hapus') {
        const body = await readBody(req);
        if (!body.jenis || !['desktop', 'mobile'].includes(body.jenis)) {
          return sendJSON(res, 400, { ok: false, pesan: 'jenis (desktop/mobile) wajib diisi' });
        }
        hapusWelcomeBg(body.jenis);
        return sendJSON(res, 200, { ok: true, pesan: 'Gambar dihapus, kembali ke background default' });
      }

      // ---- Riwayat Sholat (histori beberapa bulan, dikelompokkan per kelas/jurusan) ----
      if (req.method === 'GET' && p === '/api/riwayat') {
        const dari = url.searchParams.get('dari') || todayMinusHari(180); // default 6 bulan (~180 hari) terakhir
        const sampai = url.searchParams.get('sampai') || todayStr();
        const rows = await stmt.historiRingkasan(dari, sampai);
        const hariAktif = await stmt.hariAktifDalamRange(dari, sampai);
        const data = rows.map((r) => ({ ...r, jurusan: ekstrakJurusan(r.kelas) }));
        return sendJSON(res, 200, { ok: true, dari, sampai, totalHariAktif: hariAktif.length, data });
      }
      // ---- Rekap: matriks siswa x hari. mode = harian | mingguan | bulanan (Minggu libur, tidak ikut di mingguan/bulanan) ----
      if (req.method === 'GET' && (p === '/api/riwayat/rekap' || p === '/api/riwayat/mingguan')) {
        const acuan = /^\d{4}-\d{2}-\d{2}$/.test(url.searchParams.get('tanggal') || '') ? url.searchParams.get('tanggal') : todayStr();
        const modeMinta = url.searchParams.get('mode');
        const mode = ['harian', 'mingguan', 'bulanan'].includes(modeMinta) ? modeMinta : 'mingguan';
        const [y, m, d] = acuan.split('-').map(Number);
        const fmt = (dt) => dt.toISOString().slice(0, 10);
        let hari = [];
        if (mode === 'harian') {
          hari = [acuan];
        } else if (mode === 'mingguan') {
          const geserKeSenin = (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7; // Senin=0 ... Minggu=6
          for (let i = 0; i < 6; i++) hari.push(fmt(new Date(Date.UTC(y, m - 1, d - geserKeSenin + i))));
        } else {
          const jumlahHari = new Date(Date.UTC(y, m, 0)).getUTCDate();
          for (let i = 1; i <= jumlahHari; i++) {
            const t = new Date(Date.UTC(y, m - 1, i));
            if (t.getUTCDay() !== 0) hari.push(fmt(t)); // lewati Minggu
          }
        }
        const dari = hari[0];
        const sampai = hari[hari.length - 1];
        const siswa = await stmt.listSiswa();
        const rows = await stmt.absensiRange(dari, sampai);
        const peta = {};
        const tanggalAda = new Set();
        rows.forEach((r) => { (peta[r.kts_id] = peta[r.kts_id] || {})[r.tanggal] = { status: r.status, keterangan: r.keterangan || '', alasan_jenis: r.alasan_jenis || null }; tanggalAda.add(r.tanggal); });
        const data = siswa.map((sw) => ({
          kts_id: sw.kts_id, nama: sw.nama, kelas: sw.kelas, jurusan: ekstrakJurusan(sw.kelas),
          hari: hari.map((tgl) => peta[sw.kts_id] && peta[sw.kts_id][tgl] ? peta[sw.kts_id][tgl] : null),
        }));
        return sendJSON(res, 200, { ok: true, mode, dari, sampai, tanggal: hari, hariAktif: hari.map((t) => tanggalAda.has(t)), data });
      }
      if (req.method === 'GET' && p === '/api/riwayat/detail') {
        const kts_id = url.searchParams.get('kts_id');
        if (!kts_id) return sendJSON(res, 400, { ok: false, pesan: 'kts_id wajib diisi' });
        const dari = url.searchParams.get('dari') || todayMinusHari(180);
        const sampai = url.searchParams.get('sampai') || todayStr();
        const hariAktif = await stmt.hariAktifDalamRange(dari, sampai);
        const milikSiswa = await stmt.historiDetailSiswa(kts_id, dari, sampai);
        const petaStatus = {};
        milikSiswa.forEach((r) => { petaStatus[r.tanggal] = r.status; });
        const detail = hariAktif.map((h) => {
          const status = petaStatus[h.tanggal];
          const sholat = status === 'sudah_sholat' || status === 'sudah_pulang';
          return { tanggal: h.tanggal, sholat };
        }).reverse(); // terbaru dulu
        return sendJSON(res, 200, { ok: true, dari, sampai, data: detail });
      }
    }

    sendJSON(res, 404, { ok: false, pesan: 'Rute tidak ditemukan' });
  } catch (err) {
    console.error(err);
    sendJSON(res, 500, { ok: false, pesan: 'Terjadi kesalahan di server: ' + err.message });
  }
});

// ================= START SERVER =================
// Dulu server bisa langsung listen(). Sekarang harus nunggu database
// siap dulu (bikin tabel kalau belum ada, bikin akun admin default kalau belum ada).
async function start() {
  await initSchema();
  await ensureDefaultAdmin();
  await seedKartuSementara();

  server.listen(PORT, () => {
    console.log(`HTTP  jalan di http://localhost:${PORT}  (boleh dipakai di PC/admin, kamera TIDAK akan aktif lewat sini)`);
  });

  if (fs.existsSync(CERT_PATH) && fs.existsSync(KEY_PATH)) {
    const httpsOptions = {
      cert: fs.readFileSync(CERT_PATH),
      key: fs.readFileSync(KEY_PATH),
    };
    https.createServer(httpsOptions, server.listeners('request')[0]).listen(HTTPS_PORT, () => {
      console.log(`HTTPS jalan di https://<ip-server-ini>:${HTTPS_PORT}  (PAKAI INI di HP supaya kamera bisa aktif)`);
      console.log(`Browser akan tampilkan peringatan "Not secure" karena sertifikat self-signed — pilih "Advanced" lalu "Proceed"/"Lanjutkan", ini normal untuk pemakaian internal sekolah.`);
    });
  } else {
    console.log('Sertifikat cert.pem/key.pem tidak ditemukan — HTTPS tidak aktif, kamera di HP kemungkinan tidak akan bisa dipakai.');
  }
}

start().catch((err) => {
  console.error('=====================================================');
  console.error('Gagal menjalankan server.');
  console.error('Detail error:', err && err.message ? err.message : err);
  if (err && err.code) console.error('Kode error:', err.code);
  console.error('Kemungkinan penyebab: MySQL belum nyala, database belum dibuat,');
  console.error('atau "databaseUrl" di config.json salah (typo/format keliru).');
  console.error('=====================================================');
  process.exit(1);
});
