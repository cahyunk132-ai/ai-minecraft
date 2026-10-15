# Hyunkbot 🤖

WhatsApp bot **Hyunkbot** untuk Hyunk Store & Hyunk Panel — dibangun dengan **Baileys + Node.js + TypeScript**.  
Deploy target: VPS (Ubuntu), berjalan dengan **PM2**.

## Fitur

| Kategori | Perintah | Keterangan |
|---|---|---|
| Umum | `.menu` / `.help` | Daftar perintah + status bot (nama, prefix, owner, AI on/off) |
| Umum | `.ping` | Balasan `Pong! 🏓 X ms` |
| Umum | `.info` | Uptime, versi Node.js, memory usage |
| Umum | `.web <url>` | Scrape halaman (axios + cheerio): judul, meta description, paragraf (maks 2000 karakter) |
| Umum | `.ai <tanya>` | Tanya ke AI endpoint |
| Umum | `.sticker` | Konversi gambar (kutip / caption) menjadi sticker WA |
| Umum | `.toimg` | Konversi sticker (kutip) menjadi gambar PNG |
| Store | `.produk` | Daftar produk aktif dari Supabase (Hyunk Store) |
| Store | `.harga <nama>` | Detail produk (nama, harga, status, deskripsi) |
| Grup `[GA]` | `.tagall` | Mention semua member |
| Grup `[GA]` | `.kick @x` | Keluarkan member yang di-mention |
| Grup `[GA]` | `.add 628x` | Tambahkan nomor ke grup |
| Grup `[GA]` | `.mute` / `.unmute` | Buka/tutup grup (khusus admin) |
| Grup `[GA]` | `.hidetag <pesan>` | Tag semua member tanpa tag terlihat |
| Owner `[OWNER]` | `.setowner <628x>` / `.delowner <628x>` / `.listowner` | Kelola owner (tidak bisa hapus owner terakhir) |
| Owner `[OWNER]` | `.setai <url>` / `.toggleai` | Kelola endpoint & auto-reply AI |
| Owner `[OWNER]` | `.setprefix <c>` | Ganti prefix (1 karakter) |
| Owner `[OWNER]` | `.toggleread` | Toggle auto-read pesan |
| Owner `[OWNER]` | `.broadcast <pesan>` | Broadcast ke semua kontak (konfirmasi jumlah dulu, jeda 1 detik per pesan) |

`[GA]` = hanya admin grup. `[OWNER]` = hanya bot owner.

### AI auto-reply

Jika `aiEnabled=true` dan pesan bukan perintah, bot membalas otomatis via AI:

- Pesan mengandung **keyword toko** (`harga`, `berapa`, `produk`, `jual`, `beli`, `stok`, `tersedia`, `murah`, `mahal`, `price`, `product`, `order`, `pesan`) → bot menyertakan **konteks data produk** dari Supabase + instruksi sistem toko ke AI.
- Selain itu → pertanyaan diteruskan polos ke AI.
- Di **grup**, auto-reply hanya aktif saat bot di-mention atau pesan bot yang dikutip (agar tidak spam).

### Notifikasi panel (scheduler)

Cron `0 * * * *` (setiap jam) mengecek 4 kondisi sekaligus dan mengirim WA ke pemilik server (join `server_users` → `profiles`):

1. **H-3** — `expires_at` ≤ 3 hari 1 jam & belum disuspend
2. **H-1** — `expires_at` ≤ 1 hari 1 jam
3. **SUSPENDED** — `suspended_at` terisi
4. **DELETE** — `delete_after_at` ≤ 1 hari 1 jam

Dedup: setiap pengiriman dicatat ke tabel `notification_logs`; tipe yang sama untuk server yang sama tidak dikirim ulang dalam **25 jam**. Pengiriman diulang saat bot baru menyala (aman karena dedup).

## Struktur folder

```
wabot/
├── src/
│   ├── index.ts       # Main entry, koneksi Baileys, QR, reconnect
│   ├── config.ts      # Bot config + manajemen owner (data/config.json)
│   ├── commands.ts    # Semua handler perintah
│   ├── scraper.ts     # Web reader (axios + cheerio)
│   ├── ai.ts          # Integrasi AI
│   ├── supabase.ts    # Supabase client + queries
│   └── scheduler.ts   # Cron notifikasi panel
├── data/config.json   # Konfigurasi persisten
├── migrations/        # SQL migration (notification_logs)
├── package.json
├── tsconfig.json
└── ecosystem.config.js
```

## Environment variables (`.env`)

Salin `.env.example` menjadi `.env` lalu isi:

```env
WHATSAPP_SESSION_PATH=./session
AI_ENDPOINT=https://your-ai-endpoint.com/api/chat
SUPABASE_URL=https://xxxxx.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
PANEL_URL=https://panel.wangstore.web.id
DEFAULT_PREFIX=.
DEFAULT_OWNER_NUMBER=628xxxxxxxxxx
```

- `AI_ENDPOINT` — fallback endpoint AI (bisa dioverride via `.setai` di config.json).
- `DEFAULT_OWNER_NUMBER` — owner tambahan saat startup (format `628xxxxxxxxxx`).
- `PANEL_URL` — link yang disertakan di pesan notifikasi panel.

## Supabase

Schema `products`, `servers`, `profiles`, `server_users` **sudah ada** (READ ONLY — bot tidak membuat tabel ini).  
Jalankan migration ini di **Supabase SQL Editor** sebelum deploy bot (file: `migrations/001_notification_logs.sql`):

```sql
CREATE TABLE IF NOT EXISTS notification_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  server_id UUID,
  type TEXT NOT NULL,
  sent_at TIMESTAMPTZ DEFAULT NOW(),
  phone TEXT
);

CREATE INDEX IF NOT EXISTS idx_notification_logs_server_type
  ON notification_logs(server_id, type, sent_at);
```

## Deploy ke VPS

Prasyarat: **Node.js ≥ 22.12** (Baileys v7 bersifat ESM), npm, PM2.

```bash
# 1. Upload ke VPS
scp -r wabot/ user@vps:/home/user/

# 2. Install dependencies
cd wabot && npm install

# 3. Setup environment
cp .env.example .env
nano .env  # isi SUPABASE_URL, KEY, AI_ENDPOINT, dll

# 4. Build TypeScript
npm run build

# 5. Start dengan PM2
pm2 start ecosystem.config.js
pm2 save && pm2 startup

# 6. Scan QR (pertama kali)
pm2 logs hyunkbot
# Atau download QR via SFTP: ./session/qr.png
```

> **Tips:** Setelah scan QR pertama kali, sesi tersimpan di `WHATSAPP_SESSION_PATH` dan bot tidak perlu scan ulang saat restart.

Development lokal:

```bash
npm run dev        # ts-node langsung
npm run build      # compile ke dist/
npm start          # jalankan hasil build
```

## Catatan penting

- Nomor telepon di DB format `628xxxxxxxxxx` (tanpa `+`, tanpa spasi) → JID `628xxxxxxxxxx@s.whatsapp.net`.
- Scheduler notifikasi jalan tiap 1 jam dan mengecek 4 kondisi sekaligus.
- AI hanya menyertakan konteks toko ketika pesan mengandung keyword produk/harga.
- Semua respons bot dalam **Bahasa Indonesia**.
- Logika error: query Supabase & `sendMessage` dibungkus try/catch (gagal satu tidak menghentikan proses); reconnect otomatis dengan **exponential backoff, maksimal 5 percobaan**; QR dicetak ke terminal **dan** disimpan sebagai `./session/qr.png`.
- Bot terpisah dari Hyunk Panel — deploy di VPS yang sama dengan node atau VPS lain.
- Dependensi: `@whiskeysockets/baileys`, `axios`, `cheerio`, `@supabase/supabase-js`, `node-cron`, `qrcode`, `pino`, `dotenv`, `sharp` (konversi sticker/gambar), plus dev: `typescript`, `ts-node`.
