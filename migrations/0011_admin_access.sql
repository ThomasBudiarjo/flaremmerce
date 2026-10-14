-- Existing administrators keep full access.
ALTER TABLE admin_roles ADD COLUMN role TEXT NOT NULL DEFAULT 'owner' CHECK(role IN ('owner','ops','catalog'));
CREATE TABLE customer_bans (user_id TEXT PRIMARY KEY REFERENCES user(id) ON DELETE CASCADE, actor TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE INDEX user_created_page ON user(created_at DESC,id DESC);
-- Server-side copy of provider destination data; checkout snapshots the address from here, not the client.
CREATE TABLE shipping_destinations (id TEXT PRIMARY KEY, label TEXT NOT NULL, province TEXT NOT NULL, city TEXT NOT NULL, district TEXT NOT NULL, subdistrict TEXT NOT NULL, postal_code TEXT NOT NULL, updated_at INTEGER NOT NULL);
CREATE INDEX shipping_quotes_reuse ON shipping_quotes(fingerprint,expires_at);
