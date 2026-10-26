-- Forward-only extension of the existing saved request and global command receipts.
CREATE TABLE quotes (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  organization_id TEXT NOT NULL,
  brief_revision INTEGER NOT NULL CHECK(brief_revision>0),
  content_version INTEGER NOT NULL CHECK(content_version>0),
  state TEXT NOT NULL CHECK(state IN ('DRAFT','PUBLISHED','ACCEPTED','DECLINED','SUPERSEDED')),
  terms_json TEXT NOT NULL CHECK(json_valid(terms_json)),
  priced_brief_json TEXT NOT NULL CHECK(json_valid(priced_brief_json)),
  created_by TEXT NOT NULL REFERENCES actors(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  published_at TEXT,
  UNIQUE(id,request_id,organization_id),
  FOREIGN KEY(request_id,organization_id) REFERENCES service_requests(id,organization_id),
  FOREIGN KEY(request_id,brief_revision) REFERENCES brief_revisions(request_id,revision)
) STRICT;
CREATE UNIQUE INDEX one_published_quote ON quotes(request_id) WHERE state='PUBLISHED';
CREATE UNIQUE INDEX one_accepted_quote ON quotes(request_id) WHERE state='ACCEPTED';
ALTER TABLE service_requests ADD COLUMN current_published_quote_id TEXT REFERENCES quotes(id);
ALTER TABLE service_requests ADD COLUMN accepted_quote_id TEXT REFERENCES quotes(id);

CREATE TABLE quote_decisions (
  id TEXT PRIMARY KEY,
  quote_id TEXT NOT NULL UNIQUE,
  request_id TEXT NOT NULL,
  organization_id TEXT NOT NULL,
  decision TEXT NOT NULL CHECK(decision IN ('ACCEPT','DECLINE')),
  actor_id TEXT NOT NULL REFERENCES actors(id),
  decided_at TEXT NOT NULL,
  reason TEXT NOT NULL,
  CHECK((decision='ACCEPT' AND reason='') OR (decision='DECLINE' AND length(trim(reason)) BETWEEN 1 AND 2000)),
  FOREIGN KEY(quote_id,request_id,organization_id) REFERENCES quotes(id,request_id,organization_id)
) STRICT;
CREATE TABLE schedules (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE,
  organization_id TEXT NOT NULL,
  accepted_quote_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version>0),
  plan_json TEXT NOT NULL CHECK(json_valid(plan_json)),
  start_utc TEXT NOT NULL,
  end_utc TEXT NOT NULL CHECK(end_utc>start_utc),
  created_by TEXT NOT NULL REFERENCES actors(id),
  created_at TEXT NOT NULL,
  UNIQUE(id,request_id,organization_id),
  FOREIGN KEY(accepted_quote_id,request_id,organization_id) REFERENCES quotes(id,request_id,organization_id)
) STRICT;
CREATE TABLE clarifications (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  organization_id TEXT NOT NULL,
  actor_id TEXT NOT NULL REFERENCES actors(id),
  audience TEXT NOT NULL CHECK(audience IN ('CUSTOMER','STAFF')),
  kind TEXT NOT NULL CHECK(kind IN ('STAFF_QUESTION','CUSTOMER_REPLY','STAFF_REPLY')),
  text TEXT NOT NULL CHECK(length(trim(text)) BETWEEN 1 AND 4000),
  created_at TEXT NOT NULL,
  FOREIGN KEY(request_id,organization_id) REFERENCES service_requests(id,organization_id)
) STRICT;
CREATE INDEX messages_by_request ON clarifications(request_id,created_at,id);
CREATE TRIGGER quote_frozen_terms BEFORE UPDATE ON quotes
WHEN OLD.state<>'DRAFT' AND (
  NEW.id IS NOT OLD.id OR NEW.request_id IS NOT OLD.request_id OR NEW.organization_id IS NOT OLD.organization_id
  OR NEW.brief_revision IS NOT OLD.brief_revision OR NEW.content_version IS NOT OLD.content_version
  OR NEW.terms_json IS NOT OLD.terms_json OR NEW.priced_brief_json IS NOT OLD.priced_brief_json
  OR NEW.created_by IS NOT OLD.created_by OR NEW.created_at IS NOT OLD.created_at OR NEW.published_at IS NOT OLD.published_at)
BEGIN SELECT RAISE(ABORT,'Published quote terms are immutable'); END;
CREATE TRIGGER quote_state_transition BEFORE UPDATE ON quotes
WHEN NOT ((OLD.state='DRAFT' AND NEW.state IN ('DRAFT','PUBLISHED'))
  OR (OLD.state='PUBLISHED' AND NEW.state IN ('PUBLISHED','ACCEPTED','DECLINED','SUPERSEDED'))
  OR (OLD.state IN ('ACCEPTED','DECLINED','SUPERSEDED') AND NEW.state=OLD.state))
BEGIN SELECT RAISE(ABORT,'Published quote state cannot be reopened as a draft'); END;
CREATE TRIGGER accepted_quote_no_update BEFORE UPDATE ON quotes WHEN OLD.state='ACCEPTED'
BEGIN SELECT RAISE(ABORT,'Accepted quote is immutable'); END;
CREATE TRIGGER quote_no_delete BEFORE DELETE ON quotes BEGIN SELECT RAISE(ABORT,'Quote history cannot be deleted'); END;
CREATE TRIGGER accepted_request_association BEFORE UPDATE ON service_requests
WHEN OLD.accepted_quote_id IS NOT NULL AND (NEW.accepted_quote_id IS NOT OLD.accepted_quote_id OR NEW.current_brief_revision IS NOT OLD.current_brief_revision)
BEGIN SELECT RAISE(ABORT,'Accepted request association is immutable'); END;
CREATE TRIGGER decisions_no_update BEFORE UPDATE ON quote_decisions BEGIN SELECT RAISE(ABORT,'Quote decisions are immutable'); END;
CREATE TRIGGER decisions_no_delete BEFORE DELETE ON quote_decisions BEGIN SELECT RAISE(ABORT,'Quote decisions are immutable'); END;
CREATE TRIGGER schedules_no_update BEFORE UPDATE ON schedules BEGIN SELECT RAISE(ABORT,'Initial schedules are immutable'); END;
CREATE TRIGGER schedules_no_delete BEFORE DELETE ON schedules BEGIN SELECT RAISE(ABORT,'Initial schedules are immutable'); END;
CREATE TRIGGER clarifications_no_update BEFORE UPDATE ON clarifications BEGIN SELECT RAISE(ABORT,'Clarifications are append-only'); END;
CREATE TRIGGER clarifications_no_delete BEFORE DELETE ON clarifications BEGIN SELECT RAISE(ABORT,'Clarifications are append-only'); END;
