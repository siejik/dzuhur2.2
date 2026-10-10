// Bunyi feedback tanpa file audio eksternal (pakai WebAudio) — supaya tetap jalan walau internet lemah
// "ceting" = sukses (2 nada naik, ceria), "tetot" = gagal (2 nada rendah berulang, jelas beda)
// Audio kustom (rekaman suara sendiri) — diisi lewat muatAudioKustom(), dipakai beep() kalau ada
const audioKustom = { sukses: null, gagal: null };
async function muatAudioKustom() {
  try {
    const r = await apiGet('/api/audio/status');
    if (r.ok) {
      audioKustom.sukses = r.sukses ? new Audio(r.sukses) : null;
      audioKustom.gagal = r.gagal ? new Audio(r.gagal) : null;
    }
  } catch (e) { /* gagal ambil status audio, tetap pakai bunyi default */ }
}

function nadaTunggal(ctx, freq, mulai, durasi, volume) {
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.connect(g); g.connect(ctx.destination);
  o.frequency.value = freq;
  g.gain.value = volume;
  o.start(mulai);
  o.stop(mulai + durasi);
}
function beep(jenis) {
  // Kalau ada rekaman audio kustom buat jenis ini, pakai itu duluan
  const kustom = (jenis === 'ok' || jenis === 'warn') ? audioKustom.sukses : (jenis === 'deny' ? audioKustom.gagal : null);
  if (kustom) {
    try { kustom.currentTime = 0; kustom.play(); return; } catch (e) { /* lanjut ke bunyi default di bawah */ }
  }
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const t = ctx.currentTime;
    if (jenis === 'ok') {
      // "ceting" — dua nada naik, ceria
      nadaTunggal(ctx, 880, t, 0.09, 0.18);
      nadaTunggal(ctx, 1320, t + 0.1, 0.15, 0.18);
    } else if (jenis === 'deny') {
      // "tetot" — dua nada rendah berulang, jelas beda dari sukses
      nadaTunggal(ctx, 300, t, 0.18, 0.22);
      nadaTunggal(ctx, 300, t + 0.25, 0.18, 0.22);
    } else {
      nadaTunggal(ctx, 440, t, 0.15, 0.15);
    }
    setTimeout(() => ctx.close(), 600);
  } catch (e) { /* abaikan kalau browser tidak dukung */ }
}

async function logout() {
  await fetch('/api/logout', { method: 'POST' });
  window.location.href = '/login';
}

// Kalau sesi login sudah tidak berlaku lagi (misal: akun ini baru saja login di HP/device lain,
// jadi sesi di sini otomatis dianggap habis), langsung lempar ke halaman login.
function cekSesiHabis(res) {
  if (res.status === 401 && !location.pathname.startsWith('/login')) {
    alert('Sesi login kamu sudah berakhir (kemungkinan akun ini baru login di perangkat lain). Silakan login ulang.');
    window.location.href = '/login';
    return true;
  }
  return false;
}

async function apiPost(url, body, adminKey) {
  const headers = { 'Content-Type': 'application/json' };
  if (adminKey) headers['x-admin-key'] = adminKey;
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  if (cekSesiHabis(res)) return { ok: false, pesan: 'Sesi berakhir' };
  return res.json();
}

async function apiGet(url, adminKey) {
  const headers = {};
  if (adminKey) headers['x-admin-key'] = adminKey;
  const res = await fetch(url, { headers });
  if (cekSesiHabis(res)) return { ok: false, pesan: 'Sesi berakhir' };
  return res.json();
}

// Ubah "2026-08-07 09:49:49" jadi "7 Agustus 2026 · 09:49"
function formatWaktu(waktuStr) {
  if (!waktuStr) return '';
  const bulanNama = ['Januari','Februari','Maret','April','Mei','Juni','Juli','Agustus','September','Oktober','November','Desember'];
  const [tgl, jam] = waktuStr.split(' ');
  if (!tgl || !jam) return waktuStr;
  const [y, m, d] = tgl.split('-').map(Number);
  const jamPendek = jam.slice(0, 5);
  return `${d} ${bulanNama[m - 1]} ${y} · ${jamPendek}`;
}

// Setup scanner kamera dengan dukungan ganti kamera depan/belakang.
// Default: kamera belakang. Pilihan terakhir diingat di HP ini (localStorage).
async function initScanner(onDecoded, statusBox) {
  const scanner = new Html5Qrcode('reader');
  let cameras = [];
  try {
    cameras = await Html5Qrcode.getCameras();
  } catch (e) {
    statusBox.innerHTML = '<div class="ikon">🚫</div><div class="judul">Tidak bisa mengakses kamera. Izinkan akses kamera di browser.</div>';
    return null;
  }
  if (!cameras || !cameras.length) {
    statusBox.innerHTML = '<div class="ikon">🚫</div><div class="judul">Kamera tidak ditemukan</div>';
    return null;
  }

  const SIMPAN_KEY = 'kameraTerakhirId';
  const idxBelakang = cameras.findIndex((c) => /back|belakang|rear/i.test(c.label));
  const idSimpanan = localStorage.getItem(SIMPAN_KEY);
  let camIndex = cameras.findIndex((c) => c.id === idSimpanan);
  if (camIndex === -1) camIndex = idxBelakang !== -1 ? idxBelakang : cameras.length - 1;

  async function mulaiKamera(idx) {
    try { await scanner.stop(); } catch (e) {}
    camIndex = idx;
    localStorage.setItem(SIMPAN_KEY, cameras[camIndex].id);
    await scanner.start(
      cameras[camIndex].id,
      { fps: 10, qrbox: { width: 250, height: 150 } },
      onDecoded,
      () => {}
    );
  }
  await mulaiKamera(camIndex);

  if (cameras.length > 1) {
    const flipBtn = document.createElement('button');
    flipBtn.textContent = '🔄 Ganti Kamera (Depan/Belakang)';
    flipBtn.className = 'flip-cam-btn';
    flipBtn.type = 'button';
    flipBtn.addEventListener('click', async () => {
      await mulaiKamera((camIndex + 1) % cameras.length);
    });
    document.getElementById('reader').insertAdjacentElement('afterend', flipBtn);
  }
  return scanner;
}

// Tombol mata (lihat/sembunyikan) buat semua input password — cukup bungkus input dengan
// <div class="pass-wrap"> lalu panggil pasangTombolMata() sekali di akhir skrip halaman.
function pasangTombolMata() {
  document.querySelectorAll('.pass-wrap').forEach((wrap) => {
    const input = wrap.querySelector('input');
    if (!input || wrap.querySelector('.btn-mata')) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn-mata';
    btn.textContent = '👁️';
    btn.setAttribute('aria-label', 'Lihat/sembunyikan password');
    btn.addEventListener('click', () => {
      const terlihat = input.type === 'text';
      input.type = terlihat ? 'password' : 'text';
      btn.textContent = terlihat ? '👁️' : '🙈';
    });
    wrap.appendChild(btn);
  });
}
