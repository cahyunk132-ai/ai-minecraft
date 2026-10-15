/**
 * index.ts — Main entry Hyunkbot: koneksi Baileys, QR, auto-reconnect,
 * dispatch perintah, dan auto-reply AI.
 */
import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';

dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

import makeWASocket, {
  Browsers,
  DisconnectReason,
  extractMessageContent,
  fetchLatestBaileysVersion,
  getContentType,
  jidNormalizedUser,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
  type WASocket,
  type WAMessage,
} from '@whiskeysockets/baileys';
import pino from 'pino';
import QRCode from 'qrcode';

import { config, isOwner, normalizeJid } from './config';
import {
  getMentionedJids,
  getContextInfo,
  handleAIChat,
  handleCommand,
  rememberContact,
  type CommandContext,
} from './commands';
import { checkAndNotify, initScheduler } from './scheduler';

// ---------------------------------------------------------------------------
// Konstanta
// ---------------------------------------------------------------------------

const SESSION_PATH = path.resolve(
  __dirname,
  '..',
  process.env.WHATSAPP_SESSION_PATH || './session'
);
const MAX_RECONNECT = 5;

const logger = pino({ level: process.env.NODE_ENV === 'production' ? 'silent' : 'warn' });

let sock: WASocket | null = null;
let reconnectAttempts = 0;
let starting = false;

// ---------------------------------------------------------------------------
// Util pesan
// ---------------------------------------------------------------------------

function extractText(message: unknown): string {
  const content = extractMessageContent(message as any) || (message as any);
  const type = getContentType(content);
  if (!type) return '';
  const m = content as any;
  switch (type) {
    case 'conversation':
      return m.conversation || '';
    case 'extendedTextMessage':
      return m.extendedTextMessage?.text || '';
    case 'imageMessage':
      return m.imageMessage?.caption || '';
    case 'videoMessage':
      return m.videoMessage?.caption || '';
    case 'documentMessage':
      return m.documentMessage?.caption || '';
    case 'buttonsResponseMessage':
      return m.buttonsResponseMessage?.selectedDisplayText || m.buttonsResponseMessage?.selectedButtonId || '';
    case 'listResponseMessage':
      return m.listResponseMessage?.title || m.listResponseMessage?.singleSelectReply?.selectedRowId || '';
    case 'templateButtonReplyMessage':
      return (
        m.templateButtonReplyMessage?.selectedDisplayText || m.templateButtonReplyMessage?.selectedId || ''
      );
    default:
      return '';
  }
}

/** Utamakan JID berbasis nomor telepon (628x@s.whatsapp.net), fallback JID LID. */
function resolveSender(m: WAMessage): { sender: string; senderAlt: string } {
  const raw = m.key.participant || m.key.remoteJid || '';
  const alt =
    (m.key as any).participantAlt || (m.key as any).senderAlt || (m.key as any).remoteJidAlt || '';
  const candidates = [raw, alt].filter(Boolean);
  const phoneJid = candidates.find((j) => j.endsWith('@s.whatsapp.net'));
  const sender = jidNormalizedUser(phoneJid || raw);
  const senderAlt = jidNormalizedUser(alt || '');
  return { sender, senderAlt };
}

/** Apakah bot di-mention atau di-quote dalam pesan ini (untuk auto-reply di grup). */
function isBotAddressed(m: WAMessage, botJid: string | undefined): boolean {
  if (!botJid) return false;
  const normalizedBot = jidNormalizedUser(botJid);
  const mentioned = getMentionedJids(m);
  if (mentioned.some((j) => j === normalizedBot || normalizeJid(j) === normalizeJid(normalizedBot))) {
    return true;
  }
  const ci = getContextInfo(m);
  if (ci?.quotedMessage) {
    const quotedFrom = ci.participant ? jidNormalizedUser(ci.participant) : '';
    if (quotedFrom && (quotedFrom === normalizedBot || normalizeJid(quotedFrom) === normalizeJid(normalizedBot))) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// QR
// ---------------------------------------------------------------------------

async function displayQR(qr: string): Promise<void> {
  try {
    const ascii = await QRCode.toString(qr, { type: 'terminal', small: true, margin: 1 });
    console.log(ascii);
  } catch (err) {
    console.error('Gagal mencetak QR:', err);
  }
  const qrPath = path.join(SESSION_PATH, 'qr.png');
  try {
    await QRCode.toFile(qrPath, qr, { type: 'png', width: 400, margin: 2 });
  } catch (err) {
    console.error('Gagal menyimpan qr.png:', err);
  }
  console.log(`\n📱 Scan QR di atas dengan WhatsApp → Perangkat Tertaut.`);
  console.log(`   QR juga disimpan sebagai PNG di: ${qrPath}\n`);
}

// ---------------------------------------------------------------------------
// Handler pesan masuk
// ---------------------------------------------------------------------------

async function handleMessage(m: WAMessage): Promise<void> {
  if (!m.message) return;
  if (m.key.fromMe) return;
  const chat = m.key.remoteJid || '';
  if (!chat || chat === 'status@broadcast') return;

  const { sender, senderAlt } = resolveSender(m);
  if (!sender) return;

  rememberContact(sender);
  rememberContact(senderAlt);
  rememberContact((m.key as any).remoteJidAlt);

  if (config.readMessages) {
    try {
      await sock?.readMessages([m.key]);
    } catch {
      /* abaikan */
    }
  }

  const text = extractText(m.message).trim();
  if (!text) return;

  const isGroup = chat.endsWith('@g.us');

  // ---- Perintah ----
  if (text.startsWith(config.prefix)) {
    const body = text.slice(config.prefix.length).trim();
    if (!body) return;
    const spaceIdx = body.search(/\s/);
    const cmdRaw = spaceIdx === -1 ? body : body.slice(0, spaceIdx);
    const argText = spaceIdx === -1 ? '' : body.slice(spaceIdx + 1).trim();
    const args = argText ? argText.split(/\s+/) : [];
    const command = cmdRaw.toLowerCase();

    const ctx: CommandContext = {
      sock: sock!,
      msg: m,
      chat,
      sender,
      senderAlt,
      text,
      command,
      args,
      argText,
      isGroup,
      isOwner: isOwner(sender) || isOwner(senderAlt),
      receivedAt: Date.now(),
      reply: async (bodyText: string) => {
        await sock!.sendMessage(chat, { text: bodyText }, { quoted: m });
      },
    };
    await handleCommand(ctx);
    return;
  }

  // ---- Auto-reply AI (non-perintah) ----
  if (!config.aiEnabled) return;
  if (isGroup && !isBotAddressed(m, sock?.user?.id)) return;

  await handleAIChat(sock!, m, chat, text);
}

// ---------------------------------------------------------------------------
// Koneksi Baileys
// ---------------------------------------------------------------------------

function scheduleReconnect(delayMs: number): void {
  setTimeout(() => {
    void startBot();
  }, delayMs);
}

async function startBot(): Promise<void> {
  if (starting) return;
  starting = true;

  try {
    fs.mkdirSync(SESSION_PATH, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(SESSION_PATH);
    const { version } = await fetchVersion();

    sock = makeWASocket({
      version,
      logger,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger),
      },
      browser: Browsers.ubuntu('Chrome'),
      markOnlineOnConnect: false,
      syncFullHistory: false,
      generateHighQualityLinkPreview: false,
      getMessage: async () => undefined,
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('contacts.update', (updates) => {
      for (const u of updates || []) rememberContact((u as any).id);
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;
      for (const m of messages) {
        try {
          await handleMessage(m);
        } catch (err) {
          console.error('[message] gagal memproses pesan:', err);
        }
      }
    });

    sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        void displayQR(qr);
      }

      if (connection === 'open') {
        reconnectAttempts = 0;
        try {
          fs.unlinkSync(path.join(SESSION_PATH, 'qr.png'));
        } catch {
          /* qr.png mungkin belum ada */
        }
        console.log(`✅ Terhubung ke WhatsApp sebagai ${sock?.user?.id || '-'}`);
        initScheduler(sock!);
        // Jalankan sekali saat startup (dedup 25 jam menjaga dari dobel notifikasi)
        void checkAndNotify().catch((err) => console.error('[scheduler] startup check:', err));
      } else if (connection === 'close') {
        const err = lastDisconnect?.error as any;
        const statusCode = err?.output?.statusCode ?? err?.statusCode;
        console.log(`❌ Koneksi terputus (code: ${statusCode ?? 'unknown'})`);

        if (statusCode === DisconnectReason.loggedOut) {
          // Sesi tidak valid — hapus sesi lama supaya login baru via QR
          console.log('Sesi tidak valid (logged out). Menghapus sesi lama...');
          try {
            fs.rmSync(SESSION_PATH, { recursive: true, force: true });
          } catch {
            /* ignore */
          }
          fs.mkdirSync(SESSION_PATH, { recursive: true });
          reconnectAttempts = 0;
          scheduleReconnect(1000);
          return;
        }

        if (reconnectAttempts >= MAX_RECONNECT) {
          console.error(
            `Gagal terhubung setelah ${MAX_RECONNECT} percobaan berturut-turut. Periksa internet / sesi, lalu jalankan ulang bot.`
          );
          process.exit(1);
        }

        reconnectAttempts += 1;
        const delayMs = Math.min(30_000, 1000 * 2 ** reconnectAttempts); // 2s, 4s, 8s, 16s, 30s
        console.log(
          `Mencoba menyambung ulang (${reconnectAttempts}/${MAX_RECONNECT}) dalam ${delayMs / 1000} detik...`
        );
        scheduleReconnect(delayMs);
      }
    });
  } catch (err) {
    console.error('[startBot] gagal:', err);
    if (reconnectAttempts >= MAX_RECONNECT) process.exit(1);
    reconnectAttempts += 1;
    scheduleReconnect(Math.min(30_000, 1000 * 2 ** reconnectAttempts));
  } finally {
    starting = false;
  }
}

async function fetchVersion(): Promise<{ version: [number, number, number] }> {
  try {
    const result = await fetchLatestBaileysVersion();
    return { version: result.version as [number, number, number] };
  } catch {
    return { version: [2, 3000, 0] };
  }
}

// ---------------------------------------------------------------------------
// Jalankan
// ---------------------------------------------------------------------------

console.log('🤖 Hyunkbot starting...');
console.log(`   Session : ${SESSION_PATH}`);
console.log(`   Prefix  : ${config.prefix}`);
console.log(`   Owner   : ${config.owners.length}`);
console.log(`   AI      : ${config.aiEnabled ? 'on' : 'off'}`);

process.on('SIGINT', () => {
  console.log('\n👋 Hyunkbot dihentikan.');
  process.exit(0);
});

void startBot();
