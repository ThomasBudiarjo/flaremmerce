-- Dashboard sales count an order on the day it was paid: order_effects writes one 'paid' event per order at payment time.
CREATE INDEX order_events_paid ON order_events(created_at) WHERE kind='paid';
