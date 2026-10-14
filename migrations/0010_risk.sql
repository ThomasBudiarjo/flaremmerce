-- Risk identities are keyed HMACs (RISK_HASH_SECRET); the raw IP is never stored.
ALTER TABLE orders ADD COLUMN email_hash TEXT;
ALTER TABLE orders ADD COLUMN phone_hash TEXT;
ALTER TABLE orders ADD COLUMN ip_hash TEXT;
-- One (hash,created_at) index per identity serves pending counts, 24h velocity and per-customer limits.
CREATE INDEX orders_email_risk ON orders(email_hash,created_at) WHERE email_hash IS NOT NULL;
CREATE INDEX orders_phone_risk ON orders(phone_hash,created_at) WHERE phone_hash IS NOT NULL;
CREATE INDEX orders_ip_risk ON orders(ip_hash,created_at) WHERE ip_hash IS NOT NULL;
CREATE TRIGGER order_risk_immutable BEFORE UPDATE OF email_hash,phone_hash,ip_hash ON orders BEGIN
 SELECT RAISE(ABORT,'commercial_snapshot_immutable');
END;
CREATE INDEX review_order_open ON manual_review(order_id) WHERE status='open';
ALTER TABLE payment_events ADD COLUMN kind TEXT;
CREATE TABLE blocklist (id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('email','phone','ip')), value_hash TEXT NOT NULL CHECK(length(value_hash)=64), reason TEXT NOT NULL CHECK(length(reason) BETWEEN 1 AND 500), actor TEXT NOT NULL, created_at INTEGER NOT NULL, UNIQUE(kind,value_hash));
CREATE INDEX blocklist_page ON blocklist(created_at DESC,id DESC);
CREATE TABLE rate_counters (key TEXT NOT NULL, "window" INTEGER NOT NULL, count INTEGER NOT NULL, PRIMARY KEY(key,"window")) WITHOUT ROWID;
ALTER TABLE product_variants ADD COLUMN max_per_order INTEGER CHECK(max_per_order IS NULL OR max_per_order > 0);
ALTER TABLE product_variants ADD COLUMN max_per_customer INTEGER CHECK(max_per_customer IS NULL OR max_per_customer > 0);
-- Race backstop for checkout's friendlier pre-check: D1 serializes the batch, so concurrent orders cannot both pass.
CREATE TRIGGER item_purchase_limit BEFORE INSERT ON order_items BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM product_variants v WHERE v.id=NEW.variant_id AND (NEW.quantity > v.max_per_order OR (v.max_per_customer IS NOT NULL AND NEW.quantity + (
  SELECT coalesce(sum(i.quantity),0) FROM orders n JOIN orders o ON o.id<>n.id AND o.status<>'cancelled' AND ((n.email_hash IS NOT NULL AND o.email_hash=n.email_hash) OR (n.phone_hash IS NOT NULL AND o.phone_hash=n.phone_hash) OR (n.customer_id IS NOT NULL AND o.customer_id=n.customer_id))
  JOIN order_items i ON i.order_id=o.id AND i.variant_id=NEW.variant_id WHERE n.id=NEW.order_id) > v.max_per_customer))) THEN RAISE(ABORT,'purchase_limit') END;
END;
-- Every audit row is append-only, not only review history.
DROP TRIGGER IF EXISTS review_audit_no_update;
DROP TRIGGER IF EXISTS review_audit_no_delete;
CREATE TRIGGER audit_logs_no_update BEFORE UPDATE ON audit_logs BEGIN
 SELECT RAISE(ABORT,'audit_log_immutable');
END;
CREATE TRIGGER audit_logs_no_delete BEFORE DELETE ON audit_logs BEGIN
 SELECT RAISE(ABORT,'audit_log_immutable');
END;
