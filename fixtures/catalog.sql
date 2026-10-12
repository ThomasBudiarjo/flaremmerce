-- LOCAL DEMO ONLY. Never apply this fixture to staging or production.
INSERT OR IGNORE INTO products(id,slug,name,description) VALUES
('demo-tote','everyday-tote','Everyday Tote','Tas kanvas ringan untuk keseharian. Dibuat dalam batch kecil.'),
('demo-shirt','essential-shirt','Essential Shirt','Kemeja santai dengan potongan bersih dan bahan nyaman.'),
('demo-pouch','weekend-pouch','Weekend Pouch','Tempat untuk hal-hal kecil, dibuat khusus melalui pre-order.');
INSERT OR IGNORE INTO product_variants(id,product_id,sku,name,price,weight,mode) VALUES
('demo-tote-sand','demo-tote','TOTE-SAND','Sand',189000,350,'stock'),
('demo-tote-ink','demo-tote','TOTE-INK','Ink',199000,350,'stock'),
('demo-shirt-m','demo-shirt','SHIRT-M','Medium',329000,400,'stock'),
('demo-shirt-l','demo-shirt','SHIRT-L','Large',339000,420,'stock'),
('demo-pouch-clay','demo-pouch','POUCH-CLAY','Clay',129000,150,'preorder');
INSERT OR IGNORE INTO inventory(variant_id,on_hand) VALUES
('demo-tote-sand',12),('demo-tote-ink',8),('demo-shirt-m',6),('demo-shirt-l',4),('demo-pouch-clay',0);
INSERT OR IGNORE INTO preorder_campaigns(id,variant_id,starts_at,ends_at,ship_from,ship_to,quota)
VALUES ('demo-campaign','demo-pouch-clay',0,1792947600000,'2026-11-02','2026-11-09',20);
