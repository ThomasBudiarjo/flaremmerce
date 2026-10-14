-- Integration-side Phase 3 schema: signed-in customer address book and retention indexes for auth tables.
CREATE TABLE customer_addresses (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
 label TEXT NOT NULL CHECK(length(label) BETWEEN 1 AND 50), name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 200), phone TEXT NOT NULL CHECK(length(phone) BETWEEN 3 AND 40),
 line TEXT NOT NULL CHECK(length(line) BETWEEN 1 AND 500), destination TEXT NOT NULL REFERENCES shipping_destinations(id), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE INDEX customer_addresses_user ON customer_addresses(user_id, created_at);
-- The API pre-checks the cap for a friendly message; this closes the concurrent-insert race.
CREATE TRIGGER customer_addresses_limit BEFORE INSERT ON customer_addresses WHEN (SELECT count(*) FROM customer_addresses WHERE user_id=NEW.user_id) >= 5 BEGIN
 SELECT RAISE(ABORT,'address_limit');
END;
CREATE INDEX session_expiry ON session(expires_at);
CREATE INDEX verification_expiry ON verification(expires_at);
