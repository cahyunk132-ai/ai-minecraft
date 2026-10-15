/**
 * scheduler.ts — Cron job notifikasi panel (node-cron "0 * * * *", setiap jam).
 * 4 pemeriksaan: H-3, H-1, suspended, delete-simpan — dengan dedup 25 jam
 * via tabel notification_logs.
 */
import { schedule } from 'node-cron';
import type { WASocket } from '@whiskeysockets/baileys';
import {
  getRecentNotificationLogs,
  getServersByDeleteRange,
  getServersByExpiryRange,
  getSuspendedServers,
  getServerOwnerProfiles,
  insertNotificationLog,
  isSupabaseConfigured,
  supabase,
  type ServerRow,
} from './supabase';
import { normalizeDigits } from './config';

const PANEL_URL = process.env.PANEL_URL || 'https://panel.wangstore.web.id';
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

export type NotifyType = 'expire_h3' | 'expire_h1' | 'suspended' | 'delete_soon';

const NOTIFY_TYPES: NotifyType[] = ['expire_h3', 'expire_h1', 'suspended', 'delete_soon'];

let sock: WASocket | null = null;
let cronStarted = false;

/** Pasang socket WhatsApp ke scheduler + aktifkan cron (sekali saja). */
export function initScheduler(socket: WASocket): void {
  sock = socket;
  if (cronStarted) return;
  cronStarted = true;
  schedule('0 * * * *', () => {
    void checkAndNotify().catch((err) => console.error('[scheduler] checkAndNotify error:', err));
  });
  console.log('[scheduler] cron aktif: "0 * * * *" (setiap jam)');
}

/** Format tanggal DD/MM/YYYY */
function formatDate(value: string | Date): string {
  const date = typeof value === 'string' ? new Date(value) : value;
  return date.toLocaleDateString('id-ID', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });
}

/**
 * Kirim pesan WhatsApp ke nomor (format DB: 628xxxxxxxxxx).
 * Skip jika nomor kosong. Try/catch per pengiriman. Jeda 500ms.
 */
export async function sendWAMessage(phone: string, message: string): Promise<boolean> {
  const digits = normalizeDigits(phone || '');
  if (!sock || !digits) return false;
  const jid = `${digits}@s.whatsapp.net`;
  try {
    await sock.sendMessage(jid, { text: message });
    console.log(`[scheduler] terkirim ke ${jid}`);
    return true;
  } catch (err) {
    console.error(`[scheduler] gagal kirim ke ${jid}:`, err);
    return false;
  } finally {
    await delay(500);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface NotifyCheck {
  type: NotifyType;
  servers: ServerRow[];
  buildMessage: (server: ServerRow, ownerName: string) => string;
}

/** Jalankan 4 pemeriksaan sekaligus, kirim notifikasi yang belum pernah dikirim (25 jam terakhir). */
export async function checkAndNotify(): Promise<void> {
  if (!sock) {
    console.warn('[scheduler] socket belum siap, skip');
    return;
  }
  if (!supabase || !isSupabaseConfigured) {
    console.warn('[supabase] belum dikonfigurasi, skip notifikasi');
    return;
  }

  const now = new Date();
  const nowIso = now.toISOString();
  const in1d1h = new Date(now.getTime() + DAY + HOUR).toISOString();
  const in3d1h = new Date(now.getTime() + 3 * DAY + HOUR).toISOString();
  const since25h = new Date(now.getTime() - 25 * HOUR).toISOString();

  // 1) Dedup: ambil log 25 jam terakhir
  let logged = new Set<string>();
  try {
    const logs = await getRecentNotificationLogs(since25h);
    logged = new Set(logs.map((l) => `${l.server_id}:${l.type}`));
  } catch (err) {
    console.error('[scheduler] gagal membaca notification_logs, batal agar tidak spam:', err);
    return;
  }

  // 2) Ambil kandidat server per kondisi
  let h3Servers: ServerRow[] = [];
  let h1Servers: ServerRow[] = [];
  let suspendedServers: ServerRow[] = [];
  let deleteSoonServers: ServerRow[] = [];
  try {
    [h3Servers, h1Servers, suspendedServers, deleteSoonServers] = await Promise.all([
      getServersByExpiryRange(nowIso, in3d1h, { onlyNotSuspended: true }),
      getServersByExpiryRange(nowIso, in1d1h, { onlyNotSuspended: true }),
      getSuspendedServers(),
      getServersByDeleteRange(nowIso, in1d1h),
    ]);
  } catch (err) {
    console.error('[scheduler] gagal mengambil data servers:', err);
    return;
  }

  const checks: NotifyCheck[] = [
    {
      type: 'expire_h3',
      servers: h3Servers,
      buildMessage: (s, name) =>
        `⚠️ *Notifikasi Server Hyunk Panel*\n` +
        `Halo *${name}*!\n` +
        `Server *${s.name}* akan expired dalam 3 hari.\n` +
        `📅 Expired: ${s.expires_at ? formatDate(s.expires_at) : '-'}\n` +
        `Segera lakukan pembayaran perpanjangan.\n` +
        `Info: ${PANEL_URL}`,
    },
    {
      type: 'expire_h1',
      servers: h1Servers,
      buildMessage: (s, name) =>
        `🚨 *URGENT — Server Akan Expired!*\n` +
        `Halo *${name}*!\n` +
        `Server *${s.name}* akan expired *BESOK*!\n` +
        `Segera bayar: ${PANEL_URL}`,
    },
    {
      type: 'suspended',
      servers: suspendedServers,
      buildMessage: (s, name) =>
        `❌ *Server Disuspend*\n` +
        `Halo *${name}*!\n` +
        `Server *${s.name}* disuspend karena expired.\n` +
        `Server dihapus otomatis 7 hari jika tidak diperpanjang.\n` +
        `${PANEL_URL}`,
    },
    {
      type: 'delete_soon',
      servers: deleteSoonServers,
      buildMessage: (s, name) =>
        `💀 *Server Akan Dihapus Permanen!*\n` +
        `Halo *${name}*!\n` +
        `Server *${s.name}* DIHAPUS PERMANEN dalam 24 jam!\n` +
        `Hubungi admin: ${PANEL_URL}`,
    },
  ];

  // 3) Kirim + catat log
  for (const check of checks) {
    for (const server of check.servers) {
      const dedupKey = `${server.id}:${check.type}`;
      if (logged.has(dedupKey)) continue;

      const owners = await getServerOwnerProfiles(server.id);
      for (const owner of owners) {
        const phone = normalizeDigits(owner.phone || '');
        if (!phone) continue;
        const message = check.buildMessage(server, owner.full_name || 'Pelanggan');
        const sent = await sendWAMessage(phone, message);
        if (sent) {
          await insertNotificationLog(server.id, check.type, phone);
        }
      }
      // Tandai sudah ditangani agar siklus ini tidak mengulang
      logged.add(dedupKey);
    }
  }

  console.log(
    `[scheduler] selesai: h3=${h3Servers.length} h1=${h1Servers.length} suspended=${suspendedServers.length} delete=${deleteSoonServers.length}`
  );
}
