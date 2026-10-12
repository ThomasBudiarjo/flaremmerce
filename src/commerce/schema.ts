import { integer, sqliteTable, text, primaryKey, uniqueIndex } from 'drizzle-orm/sqlite-core';

// SQL migration additionally owns cross-row checks and atomic reservation/payment triggers.
export const products = sqliteTable('products', {
  id: text('id').primaryKey(), slug: text('slug').notNull().unique(), name: text('name').notNull(),
  description: text('description').notNull().default(''), imageUrl: text('image_url'), active: integer('active').notNull().default(1),
});
export const variants = sqliteTable('product_variants', {
  id: text('id').primaryKey(), productId: text('product_id').notNull().references(() => products.id),
  sku: text('sku').notNull().unique(), name: text('name').notNull(), price: integer('price').notNull(),
  weight: integer('weight').notNull(), mode: text('mode', { enum: ['stock', 'preorder'] }).notNull().default('stock'), active: integer('active').notNull().default(1),
});
export const inventory = sqliteTable('inventory', {
  variantId: text('variant_id').primaryKey().references(() => variants.id), onHand: integer('on_hand').notNull().default(0), reserved: integer('reserved').notNull().default(0),
});
export const campaigns = sqliteTable('preorder_campaigns', {
  id: text('id').primaryKey(), variantId: text('variant_id').notNull().references(() => variants.id), startsAt: integer('starts_at').notNull(), endsAt: integer('ends_at').notNull(),
  shipFrom: text('ship_from').notNull(), shipTo: text('ship_to').notNull(), quota: integer('quota'), reserved: integer('reserved').notNull().default(0), sold: integer('sold').notNull().default(0), active: integer('active').notNull().default(1),
});
export const orders = sqliteTable('orders', {
  id: text('id').primaryKey(), reference: text('reference').notNull().unique(), customerId: text('customer_id'), guestTokenHash: text('guest_token_hash'),
  status: text('status').notNull().default('pending_payment'), fulfillment: text('fulfillment').notNull().default('unfulfilled'), total: integer('total').notNull(), currency: text('currency').notNull().default('IDR'),
  contactJson: text('contact_json').notNull(), addressJson: text('address_json').notNull(), shippingJson: text('shipping_json').notNull(), createdAt: integer('created_at').notNull(),
});
export const checkoutRequests = sqliteTable('checkout_requests', {
  scope: text('scope').notNull(), key: text('key').notNull(), fingerprint: text('fingerprint').notNull(), orderId: text('order_id').notNull().unique().references(() => orders.id),
}, t => [primaryKey({ columns: [t.scope, t.key] })]);
export const orderItems = sqliteTable('order_items', {
  id: text('id').primaryKey(), orderId: text('order_id').notNull().references(() => orders.id), variantId: text('variant_id').notNull().references(() => variants.id), campaignId: text('campaign_id').references(() => campaigns.id), quantity: integer('quantity').notNull(), price: integer('price').notNull(), snapshotJson: text('snapshot_json').notNull(),
});
export const reservations = sqliteTable('stock_reservations', {
  itemId: text('item_id').primaryKey().references(() => orderItems.id), orderId: text('order_id').notNull().references(() => orders.id), variantId: text('variant_id').notNull().references(() => variants.id), campaignId: text('campaign_id').references(() => campaigns.id), quantity: integer('quantity').notNull(), state: text('state').notNull().default('active'),
});
export const paymentAttempts = sqliteTable('payment_attempts', {
  id: text('id').primaryKey(), orderId: text('order_id').notNull().unique().references(() => orders.id), reference: text('reference').notNull().unique(), providerId: text('provider_id').unique(), status: text('status').notNull().default('created'), url: text('url'), checks: integer('checks').notNull().default(0), nextCheck: integer('next_check').notNull(), createdAt: integer('created_at').notNull(),
});
export const paymentEvents = sqliteTable('payment_events', {
  eventKey: text('event_key').primaryKey(), reference: text('reference').notNull(), amount: integer('amount').notNull(), currency: text('currency').notNull(), status: text('status').notNull(), processed: integer('processed').notNull().default(0), createdAt: integer('created_at').notNull(),
});
export const outbox = sqliteTable('outbox_events', {
  id: text('id').primaryKey(), orderId: text('order_id').notNull().references(() => orders.id), kind: text('kind').notNull(), status: text('status').notNull().default('pending'), attempts: integer('attempts').notNull().default(0), nextRun: integer('next_run').notNull(), createdAt: integer('created_at').notNull(),
}, t => [uniqueIndex('outbox_order_kind').on(t.orderId, t.kind)]);
export const timeline = sqliteTable('order_events', {
  id: text('id').primaryKey(), orderId: text('order_id').notNull().references(() => orders.id), kind: text('kind').notNull(), detailsJson: text('details_json').notNull().default('{}'), createdAt: integer('created_at').notNull(),
});
export const inventoryMovements = sqliteTable('inventory_movements', {
  id: text('id').primaryKey(), variantId: text('variant_id').notNull().references(() => variants.id), delta: integer('delta').notNull(), reason: text('reason').notNull(), orderId: text('order_id').references(() => orders.id), actor: text('actor'), createdAt: integer('created_at').notNull(),
});
export const review = sqliteTable('manual_review', {
  id: text('id').primaryKey(), eventKey: text('event_key').unique(), orderId: text('order_id').references(() => orders.id), reason: text('reason').notNull(), createdAt: integer('created_at').notNull(),
});
export const auditLogs = sqliteTable('audit_logs', {
  id: text('id').primaryKey(), actor: text('actor').notNull(), action: text('action').notNull(), target: text('target').notNull(), detailsJson: text('details_json').notNull(), createdAt: integer('created_at').notNull(),
});
