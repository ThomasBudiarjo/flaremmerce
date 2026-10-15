-- Dashboard sales count an order on the day it was paid: order_effects writes one 'paid' event per order at payment time.
CREATE INDEX order_events_paid ON order_events(created_at) WHERE kind='paid';
-- Attempts in flight at deploy used the old relative backoff and may have spent most of their 8 lookups before
-- their deadline (at most 180 minutes after creation). Give them the new schedule's pre-deadline budget of 2,
-- so the deadline lookup still happens before an exhausted review. Exhausted attempts (8) are left alone.
UPDATE payment_attempts SET checks=2 WHERE status IN ('created','pending','unknown') AND checks BETWEEN 3 AND 7
  AND created_at > CAST(unixepoch('subsec')*1000 AS INTEGER) - 180*60000;
