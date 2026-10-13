-- Cursor pages must seek the ordered range, not scan/sort the full growing ledger.
CREATE INDEX inventory_movements_page ON inventory_movements(variant_id, created_at DESC, id DESC);
CREATE INDEX campaigns_page ON preorder_campaigns(starts_at DESC, id DESC);
