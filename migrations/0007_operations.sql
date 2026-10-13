CREATE INDEX operations_orders_age ON orders(created_at,id) WHERE status='pending_payment';
CREATE INDEX operations_payments_age ON payment_attempts(created_at,id) WHERE status IN ('created','pending','unknown');
CREATE INDEX operations_outbox_age ON outbox_events(created_at,id) WHERE status IN ('pending','dead');
CREATE INDEX operations_reviews_age ON manual_review(created_at,id) WHERE status='open';
