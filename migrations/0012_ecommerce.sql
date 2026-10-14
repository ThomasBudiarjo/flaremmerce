-- Commerce-side Phase 3 schema. Integration-owned tables change in 0013.
CREATE TABLE categories (id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 100), position INTEGER NOT NULL DEFAULT 0 CHECK(position BETWEEN 0 AND 100000), active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)), version INTEGER NOT NULL DEFAULT 0 CHECK(version >= 0));
CREATE INDEX categories_order ON categories(position, slug);
ALTER TABLE products ADD COLUMN category_id TEXT REFERENCES categories(id);
CREATE INDEX products_category ON products(category_id, slug);
-- Compare-and-swap versions for admin edits.
ALTER TABLE products ADD COLUMN version INTEGER NOT NULL DEFAULT 0 CHECK(version >= 0);
ALTER TABLE product_variants ADD COLUMN version INTEGER NOT NULL DEFAULT 0 CHECK(version >= 0);
ALTER TABLE preorder_campaigns ADD COLUMN version INTEGER NOT NULL DEFAULT 0 CHECK(version >= 0);
-- Parcel dimensions for volumetric weight; all three must be set for it to apply.
ALTER TABLE product_variants ADD COLUMN length_cm INTEGER CHECK(length_cm IS NULL OR (length_cm > 0 AND length_cm <= 300));
ALTER TABLE product_variants ADD COLUMN width_cm INTEGER CHECK(width_cm IS NULL OR (width_cm > 0 AND width_cm <= 300));
ALTER TABLE product_variants ADD COLUMN height_cm INTEGER CHECK(height_cm IS NULL OR (height_cm > 0 AND height_cm <= 300));
ALTER TABLE product_variants ADD COLUMN low_stock_threshold INTEGER CHECK(low_stock_threshold IS NULL OR (low_stock_threshold >= 0 AND low_stock_threshold <= 1000000));
-- Admin status tabs, summary aggregates and auto-complete scan in-flight statuses by recency.
CREATE INDEX orders_status_page ON orders(status, created_at DESC, id DESC);
-- Idempotency records age out after the retention window; created_at drives the bounded delete.
ALTER TABLE checkout_requests ADD COLUMN created_at INTEGER;
UPDATE checkout_requests SET created_at=(SELECT created_at FROM orders WHERE id=checkout_requests.order_id);
CREATE INDEX checkout_requests_age ON checkout_requests(created_at);
-- Optional PII redaction (ORDER_PII_RETENTION_DAYS) is the only permitted change to the commercial snapshot:
-- contact and address become a fixed marker exactly once on a finished order; every other column stays immutable.
ALTER TABLE orders ADD COLUMN pii_redacted_at INTEGER;
DROP TRIGGER order_commercial_immutable;
CREATE TRIGGER order_commercial_immutable BEFORE UPDATE OF total,currency,contact_json,address_json,shipping_json,reference,customer_id,guest_token_hash,pii_redacted_at ON orders
WHEN NOT (OLD.pii_redacted_at IS NULL AND NEW.pii_redacted_at IS NOT NULL AND OLD.status IN ('completed','cancelled') AND NEW.status=OLD.status
 AND NEW.contact_json='{"redacted":true}' AND NEW.address_json='{"redacted":true}' AND NEW.total=OLD.total AND NEW.currency=OLD.currency AND NEW.shipping_json=OLD.shipping_json
 AND NEW.reference=OLD.reference AND NEW.customer_id IS OLD.customer_id AND NEW.guest_token_hash IS OLD.guest_token_hash) BEGIN
 SELECT RAISE(ABORT,'commercial_snapshot_immutable');
END;
CREATE INDEX orders_pii_pending ON orders(created_at) WHERE pii_redacted_at IS NULL AND status IN ('completed','cancelled');
