ALTER TABLE manual_review ADD COLUMN status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','resolved'));
ALTER TABLE manual_review ADD COLUMN note TEXT NOT NULL DEFAULT '';
ALTER TABLE manual_review ADD COLUMN version INTEGER NOT NULL DEFAULT 0 CHECK(version>=0);
ALTER TABLE manual_review ADD COLUMN updated_at INTEGER;
ALTER TABLE manual_review ADD COLUMN updated_by TEXT;
CREATE INDEX payment_events_reference ON payment_events(reference,created_at DESC,event_key DESC);
CREATE INDEX audit_review_history ON audit_logs(target,action,created_at DESC,id DESC);
CREATE TRIGGER review_audit_no_update BEFORE UPDATE ON audit_logs WHEN OLD.action LIKE 'review.%'
BEGIN
  SELECT RAISE(ABORT,'review_audit_immutable');
END;
CREATE TRIGGER review_audit_no_delete BEFORE DELETE ON audit_logs WHEN OLD.action LIKE 'review.%'
BEGIN
  SELECT RAISE(ABORT,'review_audit_immutable');
END;
