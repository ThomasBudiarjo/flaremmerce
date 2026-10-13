-- Deterministic customer-only keyset pagination, including timestamp ties.
CREATE INDEX orders_customer_history ON orders(customer_id,created_at DESC,id DESC);
