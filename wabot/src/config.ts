/**
 * config.ts — Bot config & owner management.
 * Konfigurasi persisten disimpan di data/config.json.
 */
import fs from 'fs';
import path from 'path';

export interface BotConfig {
  /** JID owner, contoh: "6281234567890@s.whatsapp.net" */
  owners: string[];
  /** Prefix perintah, contoh: "." */
  prefix: string;
  /** Auto-reply AI untuk pesan non-perintah */
  aiEnabled: boolean;
  /** Tandai pesan masuk sebagai sudah dibaca */
  readMessages: boolean;
  /** Endpoint AI custom (kosongkan untuk pakai env AI_ENDPOINT) */
  aiEndpoint: string;
}

const DATA_DIR = path.resolve(__dirname, '..', 'data');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');

const DEFAULTS: BotConfig = {
  owners: [],
  prefix: '.',
  aiEnabled: true,
  readMessages: false,
  aiEndpoint: '',
};

/** Buang semua karakter non-digit */
export function normalizeDigits(input: string): string {
  return String(input || '').replace(/[^0-9]/g, '');
}

/** Validasi nomor owner: harus diawali 62 dan seluruhnya angka */
export function isValidOwnerNumber(number: string): boolean {
  return /^62\d{8,}$/.test(number);
}

export function phoneToJid(phone: string): string {
  return `${normalizeDigits(phone)}@s.whatsapp.net`;
}

export function jidToPhone(jid: string): string {
  return normalizeDigits((jid || '').split('@')[0].split(':')[0]);
}

/** Normalisasi JID: buang suffix device (:12) dan lowercase server */
export function normalizeJid(jid: string | undefined | null): string {
  if (!jid) return '';
  const [user, server] = jid.split('@');
  const cleanUser = (user || '').split(':')[0];
  return server ? `${cleanUser}@${server}` : cleanUser || '';
}

function loadConfig(): BotConfig {
  let cfg: BotConfig = { ...DEFAULTS };
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      cfg = {
        ...DEFAULTS,
        ...raw,
        owners: Array.isArray(raw.owners) ? raw.owners.filter(Boolean) : [],
      };
    }
  } catch (err) {
    console.error('[config] Gagal membaca data/config.json, memakai default:', err);
  }

  // Fallback dari environment variables
  const envPrefix = process.env.DEFAULT_PREFIX;
  if (envPrefix && !cfg.prefix) cfg.prefix = envPrefix;

  const envOwner = normalizeDigits(process.env.DEFAULT_OWNER_NUMBER || '');
  if (isValidOwnerNumber(envOwner)) {
    const jid = phoneToJid(envOwner);
    if (!cfg.owners.some((o) => normalizeJid(o) === normalizeJid(jid))) {
      cfg.owners.push(jid);
    }
  }

  if (!cfg.prefix) cfg.prefix = '.';
  return cfg;
}

export const config: BotConfig = loadConfig();

export function saveConfig(): void {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n', 'utf8');
  } catch (err) {
    console.error('[config] Gagal menyimpan data/config.json:', err);
    throw err;
  }
}

/** Cek apakah JID sender adalah owner bot */
export function isOwner(jid: string | undefined | null): boolean {
  if (!jid) return false;
  const n = normalizeJid(jid);
  if (!n) return false;
  return config.owners.some((o) => normalizeJid(o) === n);
}

/** Tambah owner. Mengembalikan JID owner baru. Melempar Error jika input tidak valid. */
export function addOwner(input: string): string {
  const digits = normalizeDigits(input);
  if (!isValidOwnerNumber(digits)) {
    throw new Error('Nomor tidak valid. Gunakan format 628xxxxxxxxxx (diawali 62, hanya angka).');
  }
  const jid = phoneToJid(digits);
  if (config.owners.some((o) => normalizeJid(o) === normalizeJid(jid))) {
    throw new Error(`Nomor ${digits} sudah terdaftar sebagai owner.`);
  }
  config.owners.push(jid);
  saveConfig();
  return jid;
}

/** Hapus owner. Melempar Error jika tidak ditemukan / tersisa satu-satunya owner. */
export function removeOwner(input: string): string {
  const digits = normalizeDigits(input);
  const jid = phoneToJid(digits);
  const idx = config.owners.findIndex((o) => normalizeJid(o) === normalizeJid(jid));
  if (idx === -1) {
    throw new Error(`Nomor ${digits} tidak terdaftar sebagai owner.`);
  }
  if (config.owners.length <= 1) {
    throw new Error('Tidak bisa menghapus owner terakhir. Tambahkan owner lain dulu.');
  }
  const [removed] = config.owners.splice(idx, 1);
  saveConfig();
  return removed;
}

/** Ganti prefix. Harus tepat 1 karakter dan bukan spasi. */
export function setPrefix(newPrefix: string): string {
  if (!newPrefix || newPrefix.length !== 1 || /\s/.test(newPrefix)) {
    throw new Error('Prefix harus tepat 1 karakter dan bukan spasi.');
  }
  config.prefix = newPrefix;
  saveConfig();
  return config.prefix;
}

export function toggleAi(): boolean {
  config.aiEnabled = !config.aiEnabled;
  saveConfig();
  return config.aiEnabled;
}

export function toggleRead(): boolean {
  config.readMessages = !config.readMessages;
  saveConfig();
  return config.readMessages;
}

/** Update endpoint AI di config. Validasi URL http(s). */
export function setAiEndpoint(url: string): string {
  const trimmed = (url || '').trim();
  if (!/^https?:\/\/.+/i.test(trimmed)) {
    throw new Error('URL tidak valid. Gunakan format https://...');
  }
  config.aiEndpoint = trimmed;
  saveConfig();
  return config.aiEndpoint;
}

/** Endpoint AI: prioritas config.json, fallback env AI_ENDPOINT */
export function getAiEndpoint(): string {
  return config.aiEndpoint || process.env.AI_ENDPOINT || '';
}
