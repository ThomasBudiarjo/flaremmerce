-- Provider transaction identity and the event that actually paid the order let the same payment seen
-- twice (webhook retry, lookup) be told apart from a genuine second payment.
ALTER TABLE payment_events ADD COLUMN provider_tx TEXT;
ALTER TABLE payment_events ADD COLUMN applied INTEGER NOT NULL DEFAULT 0 CHECK(applied IN (0,1));
UPDATE payment_events SET applied=1 WHERE event_key IN (SELECT (SELECT p.event_key FROM payment_events p WHERE p.reference=o.reference AND p.status='succeeded' AND p.processed=1 AND p.amount=o.total AND p.currency=o.currency AND NOT EXISTS(SELECT 1 FROM manual_review r WHERE r.event_key=p.event_key) ORDER BY p.created_at,p.event_key LIMIT 1) FROM orders o WHERE o.status IN ('paid','completed'));
-- Checkout computes prices, weights and totals in one request; the only race the database must close
-- is the quote expiring between that read and the reservation batch. reserve_item still guards stock/activity.
DROP TRIGGER item_snapshot_guard;
DROP TRIGGER attempt_checkout_guard;
CREATE TRIGGER attempt_checkout_guard BEFORE INSERT ON payment_attempts BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM orders o JOIN shipping_quotes q ON q.id=json_extract(o.shipping_json,'$.quoteId') WHERE o.id=NEW.order_id AND q.expires_at>CAST(unixepoch('subsec')*1000 AS INTEGER)) THEN RAISE(ABORT,'checkout_changed') END AS guard;
END;
-- Reservation counters update campaigns on every checkout; only period/activity edits can create overlap.
DROP TRIGGER campaign_overlap_update;
CREATE TRIGGER campaign_overlap_update BEFORE UPDATE OF variant_id,starts_at,ends_at,active ON preorder_campaigns WHEN NEW.active = 1 BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM preorder_campaigns WHERE id<>NEW.id AND variant_id=NEW.variant_id AND active=1 AND starts_at < NEW.ends_at AND ends_at > NEW.starts_at) THEN RAISE(ABORT,'campaign_overlap') END AS guard;
END;
-- orders_customer duplicates orders_customer_history. orders_status made the planner range-scan every
-- pending order for payment transitions and beat the partial age index; status pages need (status,created_at,id).
DROP INDEX orders_customer;
DROP INDEX orders_status;
-- Campaign estimate changes are announced to the orders that snapshot that campaign.
CREATE INDEX items_campaign ON order_items(campaign_id) WHERE campaign_id IS NOT NULL;
