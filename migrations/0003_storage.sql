CREATE TABLE product_media (
 id TEXT PRIMARY KEY, product_id TEXT REFERENCES products(id), object_key TEXT NOT NULL UNIQUE,
 url TEXT NOT NULL, content_type TEXT NOT NULL CHECK(content_type IN ('image/jpeg','image/png','image/webp')),
 size INTEGER NOT NULL CHECK(size > 0 AND size <= 5242880), actor_id TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE INDEX media_product ON product_media(product_id,created_at);
CREATE TABLE private_files (
 id TEXT PRIMARY KEY, object_key TEXT NOT NULL UNIQUE, size INTEGER NOT NULL CHECK(size > 0 AND size <= 5242880),
 actor_id TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE support_messages (
 id TEXT PRIMARY KEY, object_key TEXT NOT NULL UNIQUE,
 sender TEXT NOT NULL CHECK(length(sender)<=320), recipient TEXT NOT NULL CHECK(length(recipient)<=320),
 size INTEGER NOT NULL CHECK(size > 0 AND size <= 5242880), created_at INTEGER NOT NULL
);
CREATE INDEX support_created ON support_messages(created_at,id);
