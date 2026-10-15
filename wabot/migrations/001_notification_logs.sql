-- Hyunkbot: tabel log notifikasi (dedup) untuk scheduler panel
-- Jalankan di Supabase SQL Editor sebelum deploy bot.

CREATE TABLE IF NOT EXISTS notification_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  server_id UUID,
  type TEXT NOT NULL,
  sent_at TIMESTAMPTZ DEFAULT NOW(),
  phone TEXT
);

CREATE INDEX IF NOT EXISTS idx_notification_logs_server_type
  ON notification_logs(server_id, type, sent_at);
