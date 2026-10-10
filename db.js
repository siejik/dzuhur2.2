// ============================================================
// db.js -- Modul koneksi database (versi MySQL)
// Pengganti bagian "node:sqlite" di server.js lama.
//
// CARA PAKAI:
// 1. Install library: npm install mysql2
// 2. Isi "databaseUrl" di config.json (lihat contoh di README / pesan chat),
//    ATAU set environment variable DATABASE_URL kalau hostingnya mendukung itu.
// 3. server.js sudah otomatis pakai file ini, tidak perlu ubah apa-apa lagi.
// ============================================================

const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

// Cari alamat database: utamakan environment variable (kalau hosting kasih),
// kalau tidak ada baru dicari di config.json (lebih gampang buat pemula,
// karena tidak semua panel hosting punya menu "environment variable" yang jelas).
function ambilDatabaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  try {
    const configPath = path.join(__dirname, 'config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    if (config.databaseUrl) return config.databaseUrl;
  } catch (e) { /* config.json belum ada / belum ada field databaseUrl, biarkan */ }
  return null;
}

const databaseUrl = ambilDatabaseUrl();
if (!databaseUrl) {
  console.error('=====================================================');
  console.error('DATABASE_URL belum diisi!');
  console.error('Tambahkan field "databaseUrl" di config.json, contoh:');
  console.error('  "databaseUrl": "mysql://user:password@localhost:3306/namadb"');
  console.error('=====================================================');
}

const pool = mysql.createPool(databaseUrl);

// --- Fungsi dasar, dipakai oleh server.js ---

// Ambil banyak baris, contoh:
// const rows = await db.all('SELECT * FROM siswa WHERE kelas = ?', ['7A']);
async function all(sql, params = []) {
  const [rows] = await pool.query(sql, params);
  return rows;
}

// Ambil 1 baris saja, contoh:
// const row = await db.get('SELECT * FROM siswa WHERE kts_id = ?', [id]);
async function get(sql, params = []) {
  const [rows] = await pool.query(sql, params);
  return rows[0] || null;
}

// Jalankan perintah tanpa perlu ambil baris (CREATE/INSERT/UPDATE/DELETE), contoh:
// await db.run('UPDATE siswa SET nama = ? WHERE kts_id = ?', ['Budi', id]);
async function run(sql, params = []) {
  const [result] = await pool.query(sql, params);
  return { rowCount: result.affectedRows, insertId: result.insertId };
}

module.exports = { all, get, run, pool };

// ============================================================
// CATATAN PENTING soal beda gaya penulisan SQL vs SQLite lama:
//
// 1. Placeholder parameter: SAMA seperti dulu, pakai tanda tanya "?"
//    jadi bagian ini gak perlu diubah dari kebiasaan lama.
//
// 2. Auto-increment ID:
//    SQLite: INTEGER PRIMARY KEY AUTOINCREMENT
//    MySQL : INT AUTO_INCREMENT PRIMARY KEY
//
// 3. "INSERT OR REPLACE" (SQLite) menjadi:
//    INSERT ... ON DUPLICATE KEY UPDATE kolom = VALUES(kolom)   (MySQL)
//
// 4. MySQL mewajibkan kolom yang dipakai sebagai PRIMARY KEY / UNIQUE
//    punya panjang tertentu (pakai VARCHAR(64), bukan TEXT tanpa batas).
//    Ini sudah disesuaikan otomatis di server.js, tidak perlu diapa-apain lagi.
// ============================================================
