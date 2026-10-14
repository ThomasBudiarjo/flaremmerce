import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

// Only the catalog read model uses Drizzle; SQL migrations own the full schema, checks and triggers.
export const products = sqliteTable('products', {
  id: text('id').primaryKey(), slug: text('slug').notNull().unique(), name: text('name').notNull(),
  description: text('description').notNull().default(''), imageUrl: text('image_url'), active: integer('active').notNull().default(1),
});
export const variants = sqliteTable('product_variants', {
  id: text('id').primaryKey(), productId: text('product_id').notNull().references(() => products.id),
  sku: text('sku').notNull().unique(), name: text('name').notNull(), price: integer('price').notNull(),
  weight: integer('weight').notNull(), mode: text('mode', { enum: ['stock', 'preorder'] }).notNull().default('stock'), active: integer('active').notNull().default(1),
  maxPerOrder: integer('max_per_order'), maxPerCustomer: integer('max_per_customer'),
});
export const inventory = sqliteTable('inventory', {
  variantId: text('variant_id').primaryKey().references(() => variants.id), onHand: integer('on_hand').notNull().default(0), reserved: integer('reserved').notNull().default(0),
});
export const campaigns = sqliteTable('preorder_campaigns', {
  id: text('id').primaryKey(), variantId: text('variant_id').notNull().references(() => variants.id), startsAt: integer('starts_at').notNull(), endsAt: integer('ends_at').notNull(),
  shipFrom: text('ship_from').notNull(), shipTo: text('ship_to').notNull(), quota: integer('quota'), reserved: integer('reserved').notNull().default(0), sold: integer('sold').notNull().default(0), active: integer('active').notNull().default(1),
});
