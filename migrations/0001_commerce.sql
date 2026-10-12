PRAGMA foreign_keys = ON;
CREATE TABLE products (id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', image_url TEXT, active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)));
CREATE TABLE product_variants (id TEXT PRIMARY KEY, product_id TEXT NOT NULL REFERENCES products(id), sku TEXT NOT NULL UNIQUE, name TEXT NOT NULL, price INTEGER NOT NULL CHECK(price >= 0), weight INTEGER NOT NULL CHECK(weight > 0), mode TEXT NOT NULL DEFAULT 'stock' CHECK(mode IN ('stock','preorder')), active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)));
CREATE TABLE inventory (variant_id TEXT PRIMARY KEY REFERENCES product_variants(id), on_hand INTEGER NOT NULL DEFAULT 0 CHECK(on_hand >= 0), reserved INTEGER NOT NULL DEFAULT 0 CHECK(reserved >= 0 AND reserved <= on_hand));
CREATE TABLE preorder_campaigns (id TEXT PRIMARY KEY, variant_id TEXT NOT NULL REFERENCES product_variants(id), starts_at INTEGER NOT NULL, ends_at INTEGER NOT NULL CHECK(ends_at > starts_at), ship_from TEXT NOT NULL, ship_to TEXT NOT NULL CHECK(ship_to >= ship_from), quota INTEGER CHECK(quota IS NULL OR quota >= 0), reserved INTEGER NOT NULL DEFAULT 0 CHECK(reserved >= 0), sold INTEGER NOT NULL DEFAULT 0 CHECK(sold >= 0), active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)), CHECK(quota IS NULL OR reserved + sold <= quota));
CREATE INDEX campaigns_variant ON preorder_campaigns(variant_id, starts_at, ends_at);
CREATE TRIGGER campaign_overlap BEFORE INSERT ON preorder_campaigns WHEN NEW.active = 1 BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM preorder_campaigns WHERE variant_id=NEW.variant_id AND active=1 AND starts_at < NEW.ends_at AND ends_at > NEW.starts_at) THEN RAISE(ABORT,'campaign_overlap') END;
END;
CREATE TRIGGER campaign_overlap_update BEFORE UPDATE ON preorder_campaigns WHEN NEW.active = 1 BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM preorder_campaigns WHERE id<>NEW.id AND variant_id=NEW.variant_id AND active=1 AND starts_at < NEW.ends_at AND ends_at > NEW.starts_at) THEN RAISE(ABORT,'campaign_overlap') END;
END;
CREATE TABLE orders (id TEXT PRIMARY KEY, reference TEXT NOT NULL UNIQUE, customer_id TEXT, guest_token_hash TEXT, status TEXT NOT NULL DEFAULT 'pending_payment' CHECK(status IN ('pending_payment','paid','completed','cancelled')), fulfillment TEXT NOT NULL DEFAULT 'unfulfilled' CHECK(fulfillment IN ('unfulfilled','processing','shipped','delivered')), total INTEGER NOT NULL CHECK(total >= 0), currency TEXT NOT NULL DEFAULT 'IDR' CHECK(currency='IDR'), contact_json TEXT NOT NULL, address_json TEXT NOT NULL, shipping_json TEXT NOT NULL, created_at INTEGER NOT NULL, CHECK(customer_id IS NOT NULL OR guest_token_hash IS NOT NULL));
CREATE INDEX orders_customer ON orders(customer_id,created_at);
CREATE INDEX orders_status ON orders(status,created_at);
CREATE TABLE checkout_requests (scope TEXT NOT NULL, key TEXT NOT NULL, fingerprint TEXT NOT NULL, order_id TEXT NOT NULL UNIQUE REFERENCES orders(id), PRIMARY KEY(scope,key));
CREATE TABLE order_items (id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES orders(id), variant_id TEXT NOT NULL REFERENCES product_variants(id), campaign_id TEXT REFERENCES preorder_campaigns(id), quantity INTEGER NOT NULL CHECK(quantity > 0), price INTEGER NOT NULL CHECK(price >= 0), snapshot_json TEXT NOT NULL);
CREATE INDEX items_order ON order_items(order_id);
CREATE TABLE stock_reservations (item_id TEXT PRIMARY KEY REFERENCES order_items(id), order_id TEXT NOT NULL REFERENCES orders(id), variant_id TEXT NOT NULL REFERENCES product_variants(id), campaign_id TEXT REFERENCES preorder_campaigns(id), quantity INTEGER NOT NULL CHECK(quantity > 0), state TEXT NOT NULL DEFAULT 'active' CHECK(state IN ('active','consumed','released')));
CREATE INDEX reservations_order ON stock_reservations(order_id,state);
CREATE TABLE inventory_movements (id TEXT PRIMARY KEY, variant_id TEXT NOT NULL REFERENCES product_variants(id), delta INTEGER NOT NULL, reason TEXT NOT NULL, order_id TEXT REFERENCES orders(id), actor TEXT, created_at INTEGER NOT NULL);
CREATE TABLE payment_attempts (id TEXT PRIMARY KEY, order_id TEXT NOT NULL UNIQUE REFERENCES orders(id), reference TEXT NOT NULL UNIQUE, provider_id TEXT UNIQUE, status TEXT NOT NULL DEFAULT 'created' CHECK(status IN ('created','pending','unknown','succeeded','failed','expired')), url TEXT, checks INTEGER NOT NULL DEFAULT 0, next_check INTEGER NOT NULL, created_at INTEGER NOT NULL);
CREATE INDEX attempts_recovery ON payment_attempts(status,next_check);
CREATE TABLE payment_events (event_key TEXT PRIMARY KEY, reference TEXT NOT NULL, amount INTEGER NOT NULL, currency TEXT NOT NULL, status TEXT NOT NULL, processed INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
CREATE TABLE manual_review (id TEXT PRIMARY KEY, event_key TEXT UNIQUE, order_id TEXT REFERENCES orders(id), reason TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE order_events (id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES orders(id), kind TEXT NOT NULL, details_json TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL);
CREATE INDEX timeline_order ON order_events(order_id,created_at);
CREATE TABLE outbox_events (id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES orders(id), kind TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','done','dead')), attempts INTEGER NOT NULL DEFAULT 0, next_run INTEGER NOT NULL, created_at INTEGER NOT NULL, UNIQUE(order_id,kind));
CREATE INDEX outbox_recovery ON outbox_events(status,next_run);
CREATE TABLE audit_logs (id TEXT PRIMARY KEY, actor TEXT NOT NULL, action TEXT NOT NULL, target TEXT NOT NULL, details_json TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE INDEX review_created ON manual_review(created_at,id);
CREATE INDEX orders_created ON orders(created_at,id);
CREATE TRIGGER inventory_ledger_guard BEFORE INSERT ON inventory_movements BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM inventory WHERE variant_id=NEW.variant_id) THEN RAISE(ABORT,'inventory_missing') END;
END;
CREATE TRIGGER item_snapshot_guard BEFORE INSERT ON order_items BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM product_variants v JOIN products p ON p.id=v.product_id WHERE v.id=NEW.variant_id AND v.active=1 AND p.active=1 AND v.price=NEW.price AND v.weight=json_extract(NEW.snapshot_json,'$.weight') AND v.sku=json_extract(NEW.snapshot_json,'$.sku') AND v.mode=json_extract(NEW.snapshot_json,'$.mode')) THEN RAISE(ABORT,'catalog_changed') END;
 SELECT CASE WHEN NEW.campaign_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM preorder_campaigns WHERE id=NEW.campaign_id AND variant_id=NEW.variant_id AND ship_from=json_extract(NEW.snapshot_json,'$.campaign.shipFrom') AND ship_to=json_extract(NEW.snapshot_json,'$.campaign.shipTo')) THEN RAISE(ABORT,'campaign_changed') END;
END;
CREATE TRIGGER order_commercial_immutable BEFORE UPDATE OF total,currency,contact_json,address_json,shipping_json,reference,customer_id,guest_token_hash ON orders BEGIN
 SELECT RAISE(ABORT,'commercial_snapshot_immutable');
END;
CREATE TRIGGER item_immutable BEFORE UPDATE ON order_items BEGIN
 SELECT RAISE(ABORT,'commercial_snapshot_immutable');
END;
-- The shipping-owned table is created by 0002 before serving traffic. Checking it here,
-- at the end of the reservation batch, closes quote-expiry and catalogue update races.
CREATE TRIGGER attempt_checkout_guard BEFORE INSERT ON payment_attempts BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM orders o JOIN shipping_quotes q ON q.id=json_extract(o.shipping_json,'$.quoteId') WHERE o.id=NEW.order_id AND o.reference=NEW.reference AND o.status='pending_payment' AND q.expires_at>CAST(unixepoch('subsec')*1000 AS INTEGER) AND q.destination=json_extract(o.address_json,'$.destination') AND q.amount=json_extract(o.shipping_json,'$.amount') AND q.weight=(SELECT sum(quantity*json_extract(snapshot_json,'$.weight')) FROM order_items WHERE order_id=o.id) AND o.total=q.amount+(SELECT sum(quantity*price) FROM order_items WHERE order_id=o.id) AND (SELECT count(*) FROM order_items WHERE order_id=o.id)=(SELECT count(*) FROM stock_reservations WHERE order_id=o.id AND state='active')) THEN RAISE(ABORT,'checkout_changed') END;
END;
-- D1 batch is atomic. A failed conditional UPDATE must abort, not silently insert a reservation.
CREATE TRIGGER reserve_item BEFORE INSERT ON stock_reservations BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM orders WHERE id=NEW.order_id AND status='pending_payment') THEN RAISE(ABORT,'order_not_pending') END;
 SELECT CASE WHEN NEW.state<>'active' OR NOT EXISTS(SELECT 1 FROM order_items WHERE id=NEW.item_id AND order_id=NEW.order_id AND variant_id=NEW.variant_id AND campaign_id IS NEW.campaign_id AND quantity=NEW.quantity) THEN RAISE(ABORT,'reservation_item_mismatch') END;
 UPDATE inventory SET reserved=reserved+NEW.quantity WHERE variant_id=NEW.variant_id AND NEW.campaign_id IS NULL AND on_hand-reserved >= NEW.quantity AND EXISTS(SELECT 1 FROM product_variants v JOIN products p ON p.id=v.product_id WHERE v.id=NEW.variant_id AND v.active=1 AND p.active=1 AND v.mode='stock');
 SELECT CASE WHEN NEW.campaign_id IS NULL AND changes()<>1 THEN RAISE(ABORT,'stock_unavailable') END;
 UPDATE preorder_campaigns SET reserved=reserved+NEW.quantity WHERE id=NEW.campaign_id AND variant_id=NEW.variant_id AND active=1 AND starts_at <= CAST(unixepoch('subsec')*1000 AS INTEGER) AND ends_at > CAST(unixepoch('subsec')*1000 AS INTEGER) AND (quota IS NULL OR quota-reserved-sold >= NEW.quantity) AND EXISTS(SELECT 1 FROM product_variants v JOIN products p ON p.id=v.product_id WHERE v.id=NEW.variant_id AND v.active=1 AND p.active=1 AND v.mode='preorder');
 SELECT CASE WHEN NEW.campaign_id IS NOT NULL AND changes()<>1 THEN RAISE(ABORT,'quota_unavailable') END;
END;
CREATE TRIGGER reservation_transition BEFORE UPDATE OF state ON stock_reservations WHEN OLD.state<>NEW.state BEGIN
 SELECT CASE WHEN OLD.state<>'active' OR NEW.state NOT IN ('consumed','released') THEN RAISE(ABORT,'invalid_reservation_transition') END;
 UPDATE inventory SET reserved=reserved-OLD.quantity, on_hand=on_hand-CASE WHEN NEW.state='consumed' THEN OLD.quantity ELSE 0 END WHERE variant_id=OLD.variant_id AND OLD.campaign_id IS NULL;
 UPDATE preorder_campaigns SET reserved=reserved-OLD.quantity, sold=sold+CASE WHEN NEW.state='consumed' THEN OLD.quantity ELSE 0 END WHERE id=OLD.campaign_id;
 INSERT INTO inventory_movements(id,variant_id,delta,reason,order_id,created_at) SELECT OLD.item_id || ':' || NEW.state, OLD.variant_id, -OLD.quantity, 'sale', OLD.order_id, CAST(unixepoch('subsec')*1000 AS INTEGER) WHERE NEW.state='consumed' AND OLD.campaign_id IS NULL;
END;
CREATE TRIGGER order_transition BEFORE UPDATE OF status ON orders WHEN OLD.status<>NEW.status BEGIN
 SELECT CASE WHEN NOT ((OLD.status='pending_payment' AND NEW.status IN ('paid','cancelled')) OR (OLD.status='paid' AND NEW.status='completed' AND NEW.fulfillment='delivered')) THEN RAISE(ABORT,'invalid_order_transition') END;
END;
CREATE TRIGGER order_effects AFTER UPDATE OF status ON orders WHEN OLD.status<>NEW.status BEGIN
 UPDATE stock_reservations SET state=CASE WHEN NEW.status='paid' THEN 'consumed' ELSE 'released' END WHERE order_id=NEW.id AND state='active' AND NEW.status IN ('paid','cancelled');
 INSERT INTO order_events(id,order_id,kind,created_at) VALUES(NEW.id || ':' || NEW.status,NEW.id,NEW.status,CAST(unixepoch('subsec')*1000 AS INTEGER));
 INSERT OR IGNORE INTO outbox_events(id,order_id,kind,next_run,created_at) SELECT NEW.id || ':paid', NEW.id, 'paid',0,CAST(unixepoch('subsec')*1000 AS INTEGER) WHERE NEW.status='paid';
END;
