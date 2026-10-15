/**
 * supabase.ts — Supabase client + queries (READ ONLY untuk tabel produk/server).
 * Tabel yang dibuat bot hanya notification_logs (lihat migrations/).
 */
import { createClient, SupabaseClient } from '@supabase/supabase-js';

export interface Product {
  name: string;
  description: string | null;
  price: number;
  image_url?: string | null;
  is_active: boolean;
}

export interface ServerRow {
  id: string;
  name: string;
  uuid?: string | null;
  expires_at: string | null;
  suspended_at: string | null;
  delete_after_at: string | null;
}

export interface NotificationLogRow {
  server_id: string | null;
  type: string;
  sent_at?: string | null;
  phone?: string | null;
}

export interface OwnerProfile {
  full_name: string | null;
  phone: string | null;
}

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

export const isSupabaseConfigured = Boolean(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY);

let client: SupabaseClient | null = null;
if (isSupabaseConfigured) {
  client = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
} else {
  console.warn('[supabase] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY belum diisi — fitur store & notifikasi nonaktif.');
}

export const supabase: SupabaseClient | null = client;

/** Produk aktif, urut nama — untuk .produk */
export async function getStoreProducts(): Promise<Product[]> {
  if (!supabase) return [];
  try {
    const { data, error } = await supabase
      .from('products')
      .select('name, description, price, image_url, is_active')
      .eq('is_active', true)
      .order('name', { ascending: true });
    if (error) throw error;
    return (data || []) as Product[];
  } catch (err) {
    console.error('[supabase] getStoreProducts:', err);
    return [];
  }
}

/** Cari produk aktif berdasarkan nama (ILIKE) — untuk .harga */
export async function searchProducts(query: string): Promise<Product[]> {
  if (!supabase) return [];
  try {
    const { data, error } = await supabase
      .from('products')
      .select('name, description, price, image_url, is_active')
      .eq('is_active', true)
      .ilike('name', `%${query}%`)
      .order('name', { ascending: true });
    if (error) throw error;
    return (data || []) as Product[];
  } catch (err) {
    console.error('[supabase] searchProducts:', err);
    return [];
  }
}

/** Semua produk (termasuk non-aktif) — untuk konteks AI */
export async function getAllProductsForAI(): Promise<Product[]> {
  if (!supabase) return [];
  try {
    const { data, error } = await supabase
      .from('products')
      .select('name, description, price, is_active')
      .order('name', { ascending: true });
    if (error) throw error;
    return (data || []) as Product[];
  } catch (err) {
    console.error('[supabase] getAllProductsForAI:', err);
    return [];
  }
}

/** Log notifikasi dalam rentang waktu tertentu (untuk dedup 25 jam) */
export async function getRecentNotificationLogs(sinceIso: string): Promise<NotificationLogRow[]> {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from('notification_logs')
    .select('server_id, type, sent_at, phone')
    .gte('sent_at', sinceIso)
    .in('type', ['expire_h3', 'expire_h1', 'suspended', 'delete_soon']);
  if (error) throw error;
  return (data || []) as NotificationLogRow[];
}

/** Catat notifikasi terkirim (dedup) */
export async function insertNotificationLog(
  serverId: string,
  type: string,
  phone: string
): Promise<void> {
  if (!supabase) return;
  try {
    const { error } = await supabase
      .from('notification_logs')
      .insert({ server_id: serverId, type, phone });
    if (error) throw error;
  } catch (err) {
    console.error('[supabase] insertNotificationLog:', err);
  }
}

/** Server dengan expires_at di dalam rentang [fromIso, toIso) */
export async function getServersByExpiryRange(
  fromIso: string,
  toIso: string,
  opts: { onlyNotSuspended: boolean }
): Promise<ServerRow[]> {
  if (!supabase) return [];
  let query = supabase
    .from('servers')
    .select('id, name, uuid, expires_at, suspended_at, delete_after_at')
    .gte('expires_at', fromIso)
    .lt('expires_at', toIso);
  if (opts.onlyNotSuspended) query = query.is('suspended_at', null);
  const { data, error } = await query;
  if (error) throw error;
  return (data || []) as ServerRow[];
}

/** Server yang sedang disuspend */
export async function getSuspendedServers(): Promise<ServerRow[]> {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from('servers')
    .select('id, name, uuid, expires_at, suspended_at, delete_after_at')
    .not('suspended_at', 'is', null);
  if (error) throw error;
  return (data || []) as ServerRow[];
}

/** Server dengan delete_after_at di dalam rentang [fromIso, toIso) */
export async function getServersByDeleteRange(fromIso: string, toIso: string): Promise<ServerRow[]> {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from('servers')
    .select('id, name, uuid, expires_at, suspended_at, delete_after_at')
    .gte('delete_after_at', fromIso)
    .lt('delete_after_at', toIso);
  if (error) throw error;
  return (data || []) as ServerRow[];
}

/** Profil pemilik server (server_users.role = 'owner' → profiles) */
export async function getServerOwnerProfiles(serverId: string): Promise<OwnerProfile[]> {
  if (!supabase) return [];
  try {
    const { data, error } = await supabase
      .from('server_users')
      .select('role, profiles(full_name, phone)')
      .eq('server_id', serverId)
      .eq('role', 'owner');
    if (error) throw error;
    return (data || [])
      .map((row: { profiles: unknown }) => {
        const p = row.profiles as { full_name?: string | null; phone?: string | null } | null;
        return {
          full_name: p?.full_name ?? null,
          phone: p?.phone ?? null,
        };
      })
      .filter((p) => Boolean(p.phone));
  } catch (err) {
    console.error('[supabase] getServerOwnerProfiles:', err);
    return [];
  }
}
