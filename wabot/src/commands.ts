/**
 * commands.ts — Semua handler perintah Hyunkbot.
 * [OWNER] = bot owner only. [GA] = WhatsApp group admin only.
 */
import {
  downloadMediaMessage,
  extractMessageContent,
  areJidsSameUser,
  jidNormalizedUser,
  type WASocket,
  type WAMessage,
} from '@whiskeysockets/baileys';
import pino from 'pino';
import sharp from 'sharp';
import {
  addOwner,
  config,
  jidToPhone,
  normalizeDigits,
  removeOwner,
  setAiEndpoint,
  setPrefix,
  toggleAi,
  toggleRead,
} from './config';
import {
  getAllProductsForAI,
  getStoreProducts,
  searchProducts,
  type Product,
} from './supabase';
import { scrapeWebsite } from './scraper';
import { askAI } from './ai';

const silentLogger = pino({ level: 'silent' });

export interface CommandContext {
  sock: WASocket;
  msg: WAMessage;
  chat: string;
  sender: string;
  senderAlt: string;
  text: string;
  command: string;
  args: string[];
  argText: string;
  isGroup: boolean;
  isOwner: boolean;
  receivedAt: number;
  reply: (text: string) => Promise<void>;
}

type CommandHandler = (ctx: CommandContext) => Promise<void>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Ambil contextInfo dari pesan (untuk quoted message / mention) */
export function getContextInfo(msg: WAMessage | undefined | null): any | null {
  const message: any = msg?.message;
  if (!message) return null;
  for (const key of Object.keys(message)) {
    const value = message[key];
    if (value && typeof value === 'object' && value.contextInfo) {
      return value.contextInfo;
    }
  }
  return null;
}

/** Susun objek WAMessage dari pesan yang dikutip (untuk download media) */
export function getQuotedMessage(msg: WAMessage): WAMessage | null {
  const ci = getContextInfo(msg);
  if (!ci?.quotedMessage) return null;
  return {
    key: {
      remoteJid: msg.key.remoteJid,
      id: ci.stanzaId || undefined,
      fromMe: false,
      participant: ci.participant,
    },
    message: ci.quotedMessage,
  } as WAMessage;
}

/** JID yang di-mention dalam pesan */
export function getMentionedJids(msg: WAMessage): string[] {
  const ci = getContextInfo(msg);
  return (ci?.mentionedJid || []).map((j: string) => jidNormalizedUser(j)).filter(Boolean);
}

function isSameUser(a: string | undefined | null, b: string | undefined | null): boolean {
  if (!a || !b) return false;
  return areJidsSameUser(jidNormalizedUser(a), jidNormalizedUser(b));
}

/** Cek admin grup untuk sender */
export async function isGroupAdmin(ctx: {
  sock: WASocket;
  chat: string;
  sender: string;
  senderAlt: string;
}): Promise<boolean> {
  try {
    const meta = await ctx.sock.groupMetadata(ctx.chat);
    const participant = meta.participants.find((p: any) => {
      const ids = [p.id, p.lid, p.phoneNumber].filter(Boolean);
      return ids.some((id: string) => isSameUser(id, ctx.sender) || isSameUser(id, ctx.senderAlt));
    });
    return Boolean(participant) && participant!.admin !== null && participant!.admin !== undefined;
  } catch (err) {
    console.error('[commands] isGroupAdmin:', err);
    return false;
  }
}

/** Validasi: hanya di grup + hanya admin grup */
async function requireGroupAdmin(ctx: CommandContext): Promise<boolean> {
  if (!ctx.isGroup) {
    await ctx.reply('❌ Perintah ini hanya bisa digunakan di grup.');
    return false;
  }
  if (!(await isGroupAdmin(ctx))) {
    await ctx.reply('❌ Perintah ini khusus admin grup.');
    return false;
  }
  return true;
}

/** Validasi: hanya owner bot */
async function requireOwner(ctx: CommandContext): Promise<boolean> {
  if (!ctx.isOwner) {
    await ctx.reply('❌ Perintah ini khusus owner bot.');
    return false;
  }
  return true;
}

function formatRupiah(price: number | string): string {
  return `Rp ${Number(price || 0).toLocaleString('id-ID')}`;
}

function formatUptime(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return `${h}j ${m}m ${s}s`;
}

// ---------------------------------------------------------------------------
// Registry kontak (untuk broadcast)
// ---------------------------------------------------------------------------

const knownContacts = new Set<string>();

export function rememberContact(jid: string | undefined | null): void {
  if (!jid) return;
  const normalized = jidNormalizedUser(jid);
  if (!normalized) return;
  if (!normalized.endsWith('@s.whatsapp.net')) return;
  if (normalized === 'status@broadcast') return;
  knownContacts.add(normalized);
}

function getBroadcastTargets(): string[] {
  return [...knownContacts];
}

interface PendingBroadcast {
  text: string;
  targets: string[];
}
const pendingBroadcasts = new Map<string, PendingBroadcast>();

// ---------------------------------------------------------------------------
// Handler per perintah
// ---------------------------------------------------------------------------

const commandHandlers: Record<string, CommandHandler> = {
  // ---- Umum ---------------------------------------------------------------

  async menu(ctx) {
    const owners = config.owners.map((o) => jidToPhone(o) || o).join(', ') || '-';
    const aiState = config.aiEnabled ? '✅ Aktif' : '❌ Nonaktif';
    const text =
      `╭─〔 🤖 *HYUNKBOT* 〕\n` +
      `│ Prefix : *${config.prefix}*\n` +
      `│ Owner  : ${owners}\n` +
      `│ AI     : ${aiState}\n` +
      `│ Mode   : ${ctx.isGroup ? 'Grup' : 'Private'}\n` +
      `╰───────────────\n\n` +
      `📌 *Umum*\n` +
      `${config.prefix}menu · ${config.prefix}help · ${config.prefix}ping · ${config.prefix}info\n` +
      `${config.prefix}web <url> · ${config.prefix}ai <tanya>\n` +
      `${config.prefix}sticker · ${config.prefix}toimg\n\n` +
      `🛒 *Hyunk Store*\n` +
      `${config.prefix}produk · ${config.prefix}harga <nama>\n\n` +
      `👥 *Grup* [Admin]\n` +
      `${config.prefix}tagall · ${config.prefix}kick @x · ${config.prefix}add 628x\n` +
      `${config.prefix}mute · ${config.prefix}unmute · ${config.prefix}hidetag <pesan>\n\n` +
      `👑 *Owner*\n` +
      `${config.prefix}setowner <628x> · ${config.prefix}delowner <628x> · ${config.prefix}listowner\n` +
      `${config.prefix}setai <url> · ${config.prefix}toggleai · ${config.prefix}setprefix <c>\n` +
      `${config.prefix}toggleread · ${config.prefix}broadcast <pesan>`;
    await ctx.reply(text);
  },

  async ping(ctx) {
    const ms = Date.now() - ctx.receivedAt;
    await ctx.reply(`Pong! 🏓 ${ms} ms`);
  },

  async info(ctx) {
    const mem = process.memoryUsage();
    const mb = (n: number) => (n / 1024 / 1024).toFixed(1);
    await ctx.reply(
      `🤖 *Info Hyunkbot*\n` +
        `⏱️ Uptime: ${formatUptime(process.uptime() * 1000)}\n` +
        `🟢 Node.js: ${process.version}\n` +
        `💾 Memory: ${mb(mem.heapUsed)} MB (heap) / ${mb(mem.rss)} MB (rss)\n` +
        `📦 Platform: ${process.platform} ${process.arch}`
    );
  },

  async web(ctx) {
    const url = ctx.argText.trim();
    if (!url) {
      await ctx.reply(`Gunakan: ${config.prefix}web <url>\nContoh: ${config.prefix}web https://example.com`);
      return;
    }
    try {
      const result = await scrapeWebsite(url);
      const parts = [`🌐 *${result.title}*`, `🔗 ${result.url}`];
      if (result.description) parts.push(`\n📝 ${result.description}`);
      if (result.text) parts.push(`\n${result.text}`);
      await ctx.reply(parts.join('\n'));
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      await ctx.reply(`❌ ${detail}`);
    }
  },

  async ai(ctx) {
    const question = ctx.argText.trim();
    if (!question) {
      await ctx.reply(`Gunakan: ${config.prefix}ai <pertanyaan>`);
      return;
    }
    try {
      const answer = await askAI(question);
      await ctx.reply(answer);
    } catch (err) {
      console.error('[commands] ai:', err);
      await ctx.reply('AI sedang tidak tersedia, coba lagi nanti.');
    }
  },

  async sticker(ctx) {
    // Media dari gambar yang dikutip, atau gambar yang dikirim langsung + caption .sticker
    const quoted = getQuotedMessage(ctx.msg);
    let source: WAMessage | null = null;
    const ownContent = extractMessageContent(ctx.msg.message as any);
    if ((ownContent as any)?.imageMessage) {
      source = ctx.msg;
    } else if (quoted && (extractMessageContent(quoted.message as any) as any)?.imageMessage) {
      source = quoted;
    }
    if (!source) {
      await ctx.reply(
        `Kutip/balas gambar dengan perintah ${config.prefix}sticker, atau kirim gambar dengan caption ${config.prefix}sticker.`
      );
      return;
    }
    try {
      const buffer = await downloadMediaMessage(source, 'buffer', {}, {
        logger: silentLogger,
        reuploadRequest: ctx.sock.updateMediaMessage,
      });
      const webp = await sharp(buffer)
        .resize(512, 512, {
          fit: 'contain',
          background: { r: 0, g: 0, b: 0, alpha: 0 },
        })
        .webp({ quality: 80 })
        .toBuffer();
      await ctx.sock.sendMessage(ctx.chat, { sticker: webp }, { quoted: ctx.msg });
    } catch (err) {
      console.error('[commands] sticker:', err);
      await ctx.reply('❌ Gagal membuat sticker. Pastikan pesan yang dikutip berisi gambar valid.');
    }
  },

  async toimg(ctx) {
    const quoted = getQuotedMessage(ctx.msg);
    const quotedContent = quoted ? (extractMessageContent(quoted.message as any) as any) : null;
    if (!quoted || !quotedContent?.stickerMessage) {
      await ctx.reply(`Kutip/balas sticker dengan perintah ${config.prefix}toimg.`);
      return;
    }
    try {
      const buffer = await downloadMediaMessage(quoted, 'buffer', {}, {
        logger: silentLogger,
        reuploadRequest: ctx.sock.updateMediaMessage,
      });
      const png = await sharp(buffer).png().toBuffer();
      await ctx.sock.sendMessage(
        ctx.chat,
        { image: png, caption: '✅ Berhasil dikonversi ke gambar.' },
        { quoted: ctx.msg }
      );
    } catch (err) {
      console.error('[commands] toimg:', err);
      await ctx.reply('❌ Gagal mengonversi sticker. Pastikan pesan yang dikutip berisi sticker.');
    }
  },

  // ---- Hyunk Store --------------------------------------------------------

  async produk(ctx) {
    const products = await getStoreProducts();
    if (!products.length) {
      await ctx.reply('Belum ada produk yang tersedia. Ketik .produk lagi nanti.');
      return;
    }
    const lines = products.map(
      (p: Product, i: number) => `${i + 1}. *${p.name}* — ${formatRupiah(p.price)}\n   ${p.description || '-'}`
    );
    await ctx.reply(
      `🛒 *Daftar Produk Hyunk Store*\n\n${lines.join('\n')}\n\nKetik ${config.prefix}harga <nama> untuk detail`
    );
  },

  async harga(ctx) {
    const query = ctx.argText.trim();
    if (!query) {
      await ctx.reply(`Gunakan: ${config.prefix}harga <nama produk>`);
      return;
    }
    const products = await searchProducts(query);
    if (!products.length) {
      await ctx.reply(`Produk tidak ditemukan. Ketik ${config.prefix}produk untuk melihat semua produk.`);
      return;
    }
    const p = products[0];
    await ctx.reply(
      `🏷️ *Detail Produk*\n\n` +
        `Nama   : *${p.name}*\n` +
        `Harga  : ${formatRupiah(p.price)}\n` +
        `Status : ${p.is_active ? '✅ Tersedia' : '❌ Habis'}\n` +
        `Deskripsi : ${p.description || '-'}`
    );
  },

  // ---- Grup [GA] ----------------------------------------------------------

  async tagall(ctx) {
    if (!(await requireGroupAdmin(ctx))) return;
    const meta = await ctx.sock.groupMetadata(ctx.chat);
    const mentions = meta.participants.map((p: any) => jidNormalizedUser(p.id)).filter(Boolean);
    const list = mentions.map((jid: string, i: number) => `${i + 1}. @${jid.split('@')[0]}`).join('\n');
    await ctx.sock.sendMessage(
      ctx.chat,
      { text: `📢 *Tagall*\n\n${list}`, mentions },
      { quoted: ctx.msg }
    );
  },

  async kick(ctx) {
    if (!(await requireGroupAdmin(ctx))) return;
    const targets = resolveMentionTargets(ctx);
    if (!targets.length) {
      await ctx.reply(`Tag/member yang mau dikeluarkan.\nContoh: ${config.prefix}kick @user`);
      return;
    }
    try {
      await ctx.sock.groupParticipantsUpdate(ctx.chat, targets, 'remove');
      await ctx.reply(`✅ Berhasil mengeluarkan ${targets.length} member.`);
    } catch (err) {
      console.error('[commands] kick:', err);
      await ctx.reply('❌ Gagal mengeluarkan member. Pastikan bot admin dan target bukan admin lain.');
    }
  },

  async add(ctx) {
    if (!(await requireGroupAdmin(ctx))) return;
    const digits = normalizeDigits(ctx.argText);
    if (!/^62\d{8,}$/.test(digits)) {
      await ctx.reply(`Gunakan: ${config.prefix}add 628xxxxxxxxxx (diawali 62, hanya angka)`);
      return;
    }
    try {
      await ctx.sock.groupParticipantsUpdate(ctx.chat, [`${digits}@s.whatsapp.net`], 'add');
      await ctx.reply(`✅ Berhasil menambahkan ${digits} ke grup.`);
    } catch (err) {
      console.error('[commands] add:', err);
      await ctx.reply('❌ Gagal menambahkan member (nomor tidak valid / privasi menolak penambahan).');
    }
  },

  async mute(ctx) {
    if (!(await requireGroupAdmin(ctx))) return;
    try {
      await ctx.sock.groupSettingUpdate(ctx.chat, 'announcement');
      await ctx.reply('🔇 Grup di-mute. Sekarang hanya admin yang bisa mengirim pesan.');
    } catch (err) {
      console.error('[commands] mute:', err);
      await ctx.reply('❌ Gagal mematikan grup.');
    }
  },

  async unmute(ctx) {
    if (!(await requireGroupAdmin(ctx))) return;
    try {
      await ctx.sock.groupSettingUpdate(ctx.chat, 'not_announcement');
      await ctx.reply('🔊 Grup dibuka. Semua member bisa mengirim pesan.');
    } catch (err) {
      console.error('[commands] unmute:', err);
      await ctx.reply('❌ Gagal membuka grup.');
    }
  },

  async hidetag(ctx) {
    if (!(await requireGroupAdmin(ctx))) return;
    const message = ctx.argText.trim() || 'Halo semua!';
    const meta = await ctx.sock.groupMetadata(ctx.chat);
    const mentions = meta.participants.map((p: any) => jidNormalizedUser(p.id)).filter(Boolean);
    await ctx.sock.sendMessage(ctx.chat, { text: message, mentions }, { quoted: ctx.msg });
  },

  // ---- Owner --------------------------------------------------------------

  async setowner(ctx) {
    if (!(await requireOwner(ctx))) return;
    try {
      const jid = addOwner(ctx.argText);
      await ctx.reply(`✅ Owner ditambahkan: ${jidToPhone(jid)}`);
    } catch (err) {
      await ctx.reply(`❌ ${err instanceof Error ? err.message : 'Gagal menambahkan owner.'}`);
    }
  },

  async delowner(ctx) {
    if (!(await requireOwner(ctx))) return;
    try {
      const jid = removeOwner(ctx.argText);
      await ctx.reply(`✅ Owner dihapus: ${jidToPhone(jid)}`);
    } catch (err) {
      await ctx.reply(`❌ ${err instanceof Error ? err.message : 'Gagal menghapus owner.'}`);
    }
  },

  async listowner(ctx) {
    if (!(await requireOwner(ctx))) return;
    const list = config.owners.map((o, i) => `${i + 1}. ${jidToPhone(o) || o}`);
    await ctx.reply(`👑 *Daftar Owner*\n\n${list.join('\n')}`);
  },

  async setai(ctx) {
    if (!(await requireOwner(ctx))) return;
    try {
      const url = setAiEndpoint(ctx.argText);
      await ctx.reply(`✅ AI endpoint diperbarui:\n${url}`);
    } catch (err) {
      await ctx.reply(`❌ ${err instanceof Error ? err.message : 'Gagal memperbarui endpoint.'}`);
    }
  },

  async toggleai(ctx) {
    if (!(await requireOwner(ctx))) return;
    const state = toggleAi();
    await ctx.reply(`✅ AI auto-reply sekarang *${state ? 'AKTIF' : 'NONAKTIF'}*.`);
  },

  async setprefix(ctx) {
    if (!(await requireOwner(ctx))) return;
    try {
      const p = setPrefix(ctx.argText.trim());
      await ctx.reply(`✅ Prefix diubah menjadi: *${p}*`);
    } catch (err) {
      await ctx.reply(`❌ ${err instanceof Error ? err.message : 'Gagal mengubah prefix.'}`);
    }
  },

  async toggleread(ctx) {
    if (!(await requireOwner(ctx))) return;
    const state = toggleRead();
    await ctx.reply(`✅ Auto-read pesan sekarang *${state ? 'AKTIF' : 'NONAKTIF'}*.`);
  },

  async broadcast(ctx) {
    if (!(await requireOwner(ctx))) return;
    const text = ctx.argText.trim();
    if (!text) {
      await ctx.reply(`Gunakan: ${config.prefix}broadcast <pesan>`);
      return;
    }
    const targets = getBroadcastTargets();
    if (!targets.length) {
      await ctx.reply('❌ Belum ada kontak yang tercatat untuk broadcast.');
      return;
    }
    pendingBroadcasts.set(ctx.sender, { text, targets });
    await ctx.reply(
      `⚠️ *Konfirmasi Broadcast*\n` +
        `Pesan akan dikirim ke *${targets.length} kontak*.\n\n` +
        `Balas dengan *${config.prefix}bcconfirm* untuk mengirim,\n` +
        `atau *${config.prefix}batal* untuk membatalkan.`
    );
  },

  async bcconfirm(ctx) {
    if (!(await requireOwner(ctx))) return;
    const pending = pendingBroadcasts.get(ctx.sender);
    if (!pending) {
      await ctx.reply(`Tidak ada broadcast yang menunggu konfirmasi. Gunakan ${config.prefix}broadcast <pesan>.`);
      return;
    }
    pendingBroadcasts.delete(ctx.sender);
    await ctx.reply(`📨 Mengirim broadcast ke ${pending.targets.length} kontak...`);
    let sent = 0;
    let failed = 0;
    for (const jid of pending.targets) {
      try {
        await ctx.sock.sendMessage(jid, { text: pending.text });
        sent += 1;
      } catch (err) {
        failed += 1;
        console.error(`[broadcast] gagal ke ${jid}:`, err);
      }
      await new Promise((r) => setTimeout(r, 1000)); // jeda 1 detik
    }
    await ctx.reply(`✅ Broadcast selesai.\nTerkirim: ${sent}\nGagal: ${failed}\nTotal: ${pending.targets.length}`);
  },

  async batal(ctx) {
    if (!(await requireOwner(ctx))) return;
    if (pendingBroadcasts.delete(ctx.sender)) {
      await ctx.reply('✅ Broadcast dibatalkan.');
    } else {
      await ctx.reply('Tidak ada broadcast yang menunggu konfirmasi.');
    }
  },
};

/** Target kick: mention @user, atau pesan yang dikutip */
function resolveMentionTargets(ctx: CommandContext): string[] {
  const mentioned = getMentionedJids(ctx.msg).filter(Boolean);
  if (mentioned.length) return mentioned;
  const ci = getContextInfo(ctx.msg);
  if (ci?.participant && ci?.quotedMessage) {
    return [jidNormalizedUser(ci.participant)].filter(Boolean);
  }
  return [];
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

export async function handleCommand(ctx: CommandContext): Promise<void> {
  // Alias
  const alias: Record<string, string> = { help: 'menu', bcconfirm: 'bcconfirm' };
  const name = alias[ctx.command] || ctx.command;

  // Command pemilik tidak diekspos di menu publik tapi tetap butuh owner
  const handler = commandHandlers[name];
  if (!handler) {
    await ctx.reply(
      `Perintah *${config.prefix}${ctx.command}* tidak ditemukan. Ketik *${config.prefix}menu* untuk daftar perintah.`
    );
    return;
  }
  try {
    await handler(ctx);
  } catch (err) {
    console.error(`[commands] error pada .${name}:`, err);
    await ctx.reply('Terjadi kesalahan saat menjalankan perintah.').catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// AI auto-reply (non-command)
// ---------------------------------------------------------------------------

const STORE_KEYWORDS = [
  'harga',
  'berapa',
  'produk',
  'jual',
  'beli',
  'stok',
  'tersedia',
  'murah',
  'mahal',
  'price',
  'product',
  'order',
  'pesan',
];

export function containsStoreKeyword(text: string): boolean {
  return STORE_KEYWORDS.some((keyword) => {
    const pattern = new RegExp(`(^|[^a-zA-Z0-9])${keyword}([^a-zA-Z0-9]|$)`, 'i');
    return pattern.test(text);
  });
}

/**
 * Auto-reply AI untuk pesan non-perintah.
 * Jika pesan mengandung keyword toko → sertakan konteks produk (data dari Supabase).
 */
export async function handleAIChat(
  sock: WASocket,
  msg: WAMessage,
  chat: string,
  text: string
): Promise<void> {
  const send = async (body: string) => {
    await sock.sendMessage(chat, { text: body }, { quoted: msg });
  };

  try {
    let answer: string;
    if (containsStoreKeyword(text)) {
      const products = await getAllProductsForAI();
      const context =
        `Berikut daftar produk di Hyunk Store:\n` +
        products
          .map(
            (p) =>
              `- ${p.name}: Rp ${Number(p.price || 0).toLocaleString('id-ID')} (${p.is_active ? 'Tersedia' : 'Habis'}). ${p.description || ''}`
          )
          .join('\n');
      answer = await askAI(text, {
        context,
        system:
          'Kamu adalah asisten toko Hyunk Store. Jawab berdasarkan data produk. Harga dalam Rupiah. Jika is_active=false beritahu stok habis.',
      });
    } else {
      answer = await askAI(text);
    }
    await send(answer);
  } catch (err) {
    console.error('[commands] handleAIChat:', err);
    await send('AI sedang tidak tersedia, coba lagi nanti.').catch(() => undefined);
  }
}
