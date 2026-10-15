/**
 * ai.ts — Integrasi AI (POST ke AI_ENDPOINT).
 * Body: { message, context?, system? }
 * Respons diterima dari field: reply / response / text / answer / content.
 */
import axios from 'axios';
import { getAiEndpoint } from './config';

export interface AskAIOptions {
  /** Konteks tambahan (mis. daftar produk) */
  context?: string;
  /** Instruksi sistem (mis. persona toko) */
  system?: string;
}

/** Ekstrak teks balasan dari respons AI (field pertama yang berisi string). */
export function extractAIReply(data: unknown): string {
  if (typeof data === 'string' && data.trim()) return data.trim();
  if (data && typeof data === 'object') {
    const record = data as Record<string, unknown>;
    for (const key of ['reply', 'response', 'text', 'answer', 'content']) {
      const value = record[key];
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
  }
  return '';
}

/** Kirim pertanyaan ke AI endpoint dan kembalikan balasannya. Melempar Error jika gagal. */
export async function askAI(message: string, options: AskAIOptions = {}): Promise<string> {
  const endpoint = getAiEndpoint();
  if (!endpoint) {
    throw new Error('AI endpoint belum dikonfigurasi');
  }

  const body: Record<string, string> = { message };
  if (options.context) body.context = options.context;
  if (options.system) body.system = options.system;

  const { data } = await axios.post(endpoint, body, {
    timeout: 30000,
    headers: { 'Content-Type': 'application/json' },
  });

  const reply = extractAIReply(data);
  if (!reply) throw new Error('Respons AI tidak valid');
  return reply;
}
