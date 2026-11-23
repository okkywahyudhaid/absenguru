-- Jalankan di Supabase > SQL Editor > New query > Run

create table if not exists data_guru (
  username text primary key,
  password text not null,
  nama     text not null,
  role     text not null default 'guru'
);

create table if not exists jadwal (
  id         bigint generated always as identity primary key,
  hari       text not null,
  waktu      text not null,
  jam        int  not null,
  piket      text default '',
  kelas      text not null,
  kode_guru  text default ''
);
create index if not exists jadwal_slot_idx on jadwal (hari, waktu, jam);

create table if not exists log_absensi (
  id          bigint generated always as identity primary key,
  "timestamp" timestamptz not null default now(),
  tanggal     date not null,
  hari        text,
  guru_piket  text,
  kelas       text not null,
  jam_ke      int  not null,
  guru_mapel  text,
  status      text,
  keterangan  text,
  unique (tanggal, kelas, jam_ke)
);

create table if not exists sessions (
  token      text primary key,
  data       jsonb not null,
  expires_at timestamptz not null
);

-- Keamanan: aktifkan RLS tanpa policy => tabel TIDAK bisa diakses publik.
-- Hanya server Vercel (memakai service role key) yang bisa membaca/menulis.
alter table data_guru    enable row level security;
alter table jadwal       enable row level security;
alter table log_absensi  enable row level security;
alter table sessions     enable row level security;

-- Akun admin awal (GANTI password setelah login pertama)
insert into data_guru (username, password, nama, role)
values ('admin', 'admin123', 'Administrator', 'admin')
on conflict (username) do nothing;
