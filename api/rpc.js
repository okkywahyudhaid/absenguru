// Pengganti Code.gs: semua fungsi Apps Script dipanggil lewat /api/rpc
const { createClient } = require('@supabase/supabase-js');

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false }
});
const HARI = ['Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];
const TTL_MS = 6 * 3600 * 1000;

// ---------- helper ----------
async function fetchAll(table, build) {
  var out = [], from = 0, step = 1000;
  for (;;) {
    var q = sb.from(table).select('*');
    if (build) q = build(q);
    var r = await q.range(from, from + step - 1);
    if (r.error) throw new Error(r.error.message);
    out = out.concat(r.data);
    if (r.data.length < step) break;
    from += step;
  }
  return out;
}
function must(r) { if (r.error) throw new Error(r.error.message); return r.data; }
const low = (v) => String(v == null ? '' : v).trim().toLowerCase();

async function auth_(token, needAdmin) {
  var r = await sb.from('sessions').select('data,expires_at').eq('token', String(token || '')).maybeSingle();
  if (r.error) throw new Error(r.error.message);
  if (!r.data || new Date(r.data.expires_at) < new Date()) throw new Error('Sesi habis, silakan login ulang.');
  var u = r.data.data;
  if (needAdmin && u.role !== 'admin') throw new Error('Hanya admin yang boleh mengakses.');
  return u;
}

// ---------- SESI ----------
async function login(username, password) {
  var users = await fetchAll('data_guru');
  for (var i = 0; i < users.length; i++) {
    var d = users[i];
    if (low(d.username) === low(username) && String(d.password) === String(password)) {
      var user = { username: d.username, name: d.nama, role: low(d.role) || 'guru' };
      var token = require('crypto').randomUUID();
      must(await sb.from('sessions').insert({ token: token, data: user, expires_at: new Date(Date.now() + TTL_MS).toISOString() }));
      sb.from('sessions').delete().lt('expires_at', new Date().toISOString()).then(function () {}); // bersihkan sesi lama
      return Object.assign({}, user, { token: token, success: true });
    }
  }
  return { success: false, message: 'Username atau Password salah!' };
}
async function logout(token) { await sb.from('sessions').delete().eq('token', String(token || '')); }

// ---------- DATA UMUM ----------
async function getListGuru(token) {
  await auth_(token);
  var d = await fetchAll('data_guru'), seen = {}, list = [];
  d.forEach(function (g) {
    var nama = String(g.nama || '').trim(), k = nama.toLowerCase();
    if (nama && low(g.role) !== 'admin' && !seen[k]) { seen[k] = 1; list.push(nama); }
  });
  return list.sort(function (a, b) { return a.localeCompare(b, 'id'); });
}

async function getJadwal(token) {
  await auth_(token);
  var g = await fetchAll('data_guru'), map = {};
  g.forEach(function (x) { map[String(x.username).toUpperCase()] = x.nama; });
  var d = await fetchAll('jadwal', function (q) { return q.order('id'); });
  return d.map(function (r) {
    return { row: r.id, hari: r.hari, waktu: r.waktu, jam: Number(r.jam), piket: r.piket || '', kelas: r.kelas,
      kode: r.kode_guru || '', guru: map[String(r.kode_guru || '').toUpperCase()] || '' };
  });
}

// ---------- ADMIN: JADWAL ----------
async function simpanJadwal(token, f) {
  await auth_(token, true);
  var hari = String(f.hari || '').trim(), waktu = String(f.waktu || '').trim(), jam = Number(f.jam);
  var piket = String(f.piket || '').trim(), kelas = String(f.kelas || '').trim().toUpperCase();
  var namaGuru = String(f.guru || '').trim();

  if (HARI.indexOf(hari) < 0) return { success: false, message: 'Hari tidak valid.' };
  if (!waktu) return { success: false, message: 'Waktu pelajaran wajib diisi.' };
  if (!Number.isInteger(jam) || jam < 1 || jam > 12) return { success: false, message: 'Jam pelajaran harus berupa angka 1–12.' };
  if (!/^([789])[A-H]$/.test(kelas)) return { success: false, message: 'Kelas tidak valid.' };
  if (!namaGuru) return { success: false, message: 'Guru mata pelajaran wajib dipilih.' };

  var guru = await fetchAll('data_guru'), kode = '';
  for (var i = 0; i < guru.length; i++) {
    if (low(guru[i].nama) === namaGuru.toLowerCase() && low(guru[i].role) !== 'admin') { kode = String(guru[i].username).trim(); break; }
  }
  if (!kode) return { success: false, message: 'Guru tidak ditemukan atau akun bukan berstatus guru.' };

  var id = Number(f.row || 0);
  var dup = must(await sb.from('jadwal').select('id').eq('hari', hari).eq('kelas', kelas).eq('jam', jam));
  if (dup.some(function (x) { return x.id !== id; }))
    return { success: false, message: 'Jadwal untuk ' + hari + ', kelas ' + kelas + ', jam ke-' + jam + ' sudah ada.' };

  if (id > 0) {
    var ex = must(await sb.from('jadwal').select('id').eq('id', id));
    if (ex.length) { // kolom guru piket tidak diubah
      must(await sb.from('jadwal').update({ hari: hari, waktu: waktu, jam: jam, kelas: kelas, kode_guru: kode }).eq('id', id));
      return { success: true, message: 'Jadwal ' + hari + ' kelas ' + kelas + ' jam ke-' + jam + ' berhasil diperbarui.' };
    }
  }
  must(await sb.from('jadwal').insert({ hari: hari, waktu: waktu, jam: jam, piket: piket, kelas: kelas, kode_guru: kode }));
  return { success: true, message: 'Jadwal baru berhasil ditambahkan.' };
}

async function simpanGuruPiket(token, f) {
  await auth_(token, true);
  f = f || {};
  var hari = String(f.hari || '').trim(), waktu = String(f.waktu || '').trim(), jam = Number(f.jam);
  var namaGuru = String(f.guru || '').trim();
  if (HARI.indexOf(hari) < 0) return { success: false, message: 'Hari tidak valid.' };
  if (!waktu) return { success: false, message: 'Waktu pelajaran harus dipilih.' };
  if (!Number.isInteger(jam) || jam < 1 || jam > 12) return { success: false, message: 'Jam pelajaran tidak valid.' };
  if (!namaGuru) return { success: false, message: 'Silakan pilih guru piket.' };

  var guru = await fetchAll('data_guru');
  var valid = guru.some(function (g) { return low(g.nama) === namaGuru.toLowerCase() && low(g.role) !== 'admin'; });
  if (!valid) return { success: false, message: 'Guru tidak ditemukan dalam daftar guru.' };

  var rows = must(await sb.from('jadwal').update({ piket: namaGuru }).eq('hari', hari).eq('waktu', waktu).eq('jam', jam).select('id'));
  if (!rows.length) return { success: false, message: 'Slot jadwal tidak ditemukan. Periksa hari, waktu, dan jam yang dipilih.' };
  return { success: true, message: 'Guru piket berhasil diperbarui untuk ' + hari + ', jam ke-' + jam + ' (' + rows.length + ' kelas).' };
}

async function hapusJadwal(token, row) {
  await auth_(token, true);
  row = Number(row);
  if (!Number.isInteger(row) || row < 1) return { success: false, message: 'Baris jadwal tidak valid.' };
  var r = must(await sb.from('jadwal').delete().eq('id', row).select('id'));
  if (!r.length) return { success: false, message: 'Baris jadwal tidak valid.' };
  return { success: true, message: 'Jadwal berhasil dihapus.' };
}

// ---------- GURU: ABSENSI ----------
async function simpanAbsensi(token, f) {
  var u = await auth_(token);
  var ex = must(await sb.from('log_absensi').select('id').eq('tanggal', f.tanggal).eq('kelas', f.kelas).eq('jam_ke', Number(f.jamKe)));
  var rec = { timestamp: new Date().toISOString(), tanggal: f.tanggal, hari: f.hari, guru_piket: u.name, kelas: f.kelas,
    jam_ke: Number(f.jamKe), guru_mapel: f.guruMapel, status: f.status, keterangan: f.keterangan || '' };
  must(await sb.from('log_absensi').upsert(rec, { onConflict: 'tanggal,kelas,jam_ke' }));
  return { success: true, message: ex.length ? 'Data kelas ' + f.kelas + ' jam ke-' + f.jamKe + ' diperbarui.' : 'Data absensi berhasil disimpan!' };
}

async function getTerisi(token, tanggal) {
  await auth_(token);
  var d = must(await sb.from('log_absensi').select('kelas,jam_ke,status').eq('tanggal', tanggal)), o = {};
  d.forEach(function (x) { o[x.kelas + '|' + Number(x.jam_ke)] = x.status; });
  return o;
}

// ---------- ADMIN: DASHBOARD ----------
async function getDashboard(token, senin) {
  await auth_(token, true);
  var p = senin.split('-'), tgl = {}, list = [];
  HARI.forEach(function (h, i) {
    var x = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2] + i)).toISOString().slice(0, 10);
    tgl[h] = x; list.push(x);
  });
  var d = await fetchAll('log_absensi', function (q) { return q.gte('tanggal', list[0]).lte('tanggal', list[5]); });
  var log = {};
  d.forEach(function (x) { log[x.tanggal + '|' + x.kelas + '|' + Number(x.jam_ke)] = { s: x.status, k: x.keterangan, m: x.guru_mapel }; });
  var jd = await getJadwal(token);
  var cells = jd.map(function (r) {
    var t = tgl[r.hari], l = log[t + '|' + r.kelas + '|' + r.jam] || {};
    return { hari: r.hari, waktu: r.waktu, jam: r.jam, piket: r.piket, kelas: r.kelas, kode: r.kode, guru: r.guru, tanggal: t, s: l.s || '', k: l.k || '' };
  });
  return { tanggal: tgl, cells: cells };
}

// ---------- ADMIN: USER ----------
async function listUser(token) {
  await auth_(token, true);
  var d = await fetchAll('data_guru');
  return d.filter(function (x) { return x.username; }).map(function (x) { return { username: x.username, nama: x.nama, role: x.role || 'guru' }; });
}

async function tambahUser(token, u) {
  await auth_(token, true);
  if (!u.username || !u.password || !u.nama) return { success: false, message: 'Semua kolom wajib diisi.' };
  var d = await fetchAll('data_guru');
  if (d.some(function (x) { return low(x.username) === low(u.username); })) return { success: false, message: 'Username sudah dipakai.' };
  must(await sb.from('data_guru').insert({ username: u.username.trim(), password: u.password, nama: u.nama.trim(), role: u.role === 'admin' ? 'admin' : 'guru' }));
  return { success: true, message: 'User ' + u.nama + ' berhasil ditambahkan.' };
}

async function hapusUser(token, username) {
  var me = await auth_(token, true);
  if (low(username) === low(me.username)) return { success: false, message: 'Tidak bisa menghapus akun sendiri.' };
  var r = must(await sb.from('data_guru').delete().eq('username', username).select('username'));
  return r.length ? { success: true, message: 'User dihapus.' } : { success: false, message: 'User tidak ditemukan.' };
}

async function editUser(token, u) {
  var me = await auth_(token, true);
  if (!u.nama || !String(u.nama).trim()) return { success: false, message: 'Nama wajib diisi.' };
  var role = u.role === 'admin' ? 'admin' : 'guru';
  var d = await fetchAll('data_guru'), target = null, admins = 0;
  d.forEach(function (x) {
    if (low(x.role) === 'admin') admins++;
    if (low(x.username) === low(u.username)) target = x;
  });
  if (!target) return { success: false, message: 'User tidak ditemukan.' };
  if (low(target.role) === 'admin' && role !== 'admin' && admins <= 1) return { success: false, message: 'Tidak bisa menurunkan admin terakhir.' };
  var self = low(target.username) === low(me.username);
  if (self && role !== 'admin') return { success: false, message: 'Tidak bisa menurunkan role akun sendiri.' };
  var upd = { nama: String(u.nama).trim(), role: role };
  if (u.password) upd.password = u.password;
  must(await sb.from('data_guru').update(upd).eq('username', target.username));
  if (self) {
    me.name = upd.nama;
    must(await sb.from('sessions').update({ data: me }).eq('token', token));
  }
  return { success: true, message: 'Data ' + upd.nama + ' berhasil diperbarui.' };
}

async function getAktivitas(token) {
  await auth_(token, true);
  var d = must(await sb.from('log_absensi').select('*').order('timestamp', { ascending: false }).limit(8));
  var fmt = new Intl.DateTimeFormat('id-ID', { timeZone: 'Asia/Jakarta', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
  return d.map(function (x) {
    var pr = {}; fmt.formatToParts(new Date(x.timestamp)).forEach(function (t) { pr[t.type] = t.value; });
    return { jam: pr.day + '/' + pr.month + ' ' + pr.hour + ':' + pr.minute, piket: x.guru_piket, kelas: x.kelas, ke: x.jam_ke, guru: x.guru_mapel, s: x.status };
  });
}

const FN = { login, logout, getListGuru, getJadwal, simpanJadwal, simpanGuruPiket, hapusJadwal, simpanAbsensi,
  getTerisi, getDashboard, listUser, tambahUser, hapusUser, editUser, getAktivitas };

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY)
      throw new Error('Environment variable SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY belum diisi di Vercel.');
    var body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    if (!Object.prototype.hasOwnProperty.call(FN, body.fn)) throw new Error('Fungsi tidak dikenal: ' + body.fn);
    var result = await FN[body.fn].apply(null, body.args || []);
    return res.status(200).json({ result: result === undefined ? null : result });
  } catch (e) {
    return res.status(200).json({ error: e.message || String(e) });
  }
};
