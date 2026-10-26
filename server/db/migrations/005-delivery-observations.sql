-- Delivery history and owned point notes extend the existing request and global receipts.
CREATE TABLE deliveries (
  id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE, organization_id TEXT NOT NULL,
  schedule_id TEXT NOT NULL, result_id TEXT NOT NULL, accepted_quote_id TEXT NOT NULL,
  brief_revision INTEGER NOT NULL CHECK(brief_revision>0), request_version INTEGER NOT NULL CHECK(request_version>0),
  material_version INTEGER NOT NULL CHECK(material_version>0), access_version INTEGER NOT NULL CHECK(access_version>0),
  note TEXT NOT NULL CHECK(length(trim(note)) BETWEEN 1 AND 4000),
  readiness_json TEXT NOT NULL CHECK(json_valid(readiness_json)),
  actor_id TEXT NOT NULL REFERENCES actors(id), created_at TEXT NOT NULL,
  FOREIGN KEY(request_id,organization_id) REFERENCES service_requests(id,organization_id),
  FOREIGN KEY(schedule_id,request_id,organization_id) REFERENCES schedules(id,request_id,organization_id),
  FOREIGN KEY(result_id,request_id,organization_id) REFERENCES result_sets(id,request_id,organization_id),
  FOREIGN KEY(accepted_quote_id,request_id,organization_id) REFERENCES quotes(id,request_id,organization_id),
  FOREIGN KEY(request_id,brief_revision) REFERENCES brief_revisions(request_id,revision)
) STRICT;
CREATE TABLE observations (
  id TEXT PRIMARY KEY, result_id TEXT NOT NULL, organization_id TEXT NOT NULL,
  asset_id TEXT NOT NULL, content_version INTEGER NOT NULL,
  author_id TEXT NOT NULL REFERENCES actors(id),
  x REAL NOT NULL CHECK(x>=0 AND x<=1), y REAL NOT NULL CHECK(y>=0 AND y<=1),
  text TEXT NOT NULL CHECK(length(trim(text)) BETWEEN 1 AND 2000),
  version INTEGER NOT NULL CHECK(version>0), created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT,
  UNIQUE(id,result_id,organization_id),
  FOREIGN KEY(asset_id,content_version,result_id,organization_id) REFERENCES image_versions(asset_id,content_version,result_id,organization_id)
) STRICT;
CREATE INDEX observations_by_result ON observations(result_id,created_at);
CREATE TABLE observation_events (
  id TEXT PRIMARY KEY, observation_id TEXT NOT NULL, result_id TEXT NOT NULL, organization_id TEXT NOT NULL,
  actor_id TEXT NOT NULL REFERENCES actors(id), version INTEGER NOT NULL CHECK(version>0),
  kind TEXT NOT NULL CHECK(kind IN ('CREATE','UPDATE','DELETE')),
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)), occurred_at TEXT NOT NULL,
  UNIQUE(observation_id,version),
  FOREIGN KEY(observation_id,result_id,organization_id) REFERENCES observations(id,result_id,organization_id)
) STRICT;
CREATE TRIGGER deliveries_no_update BEFORE UPDATE ON deliveries BEGIN SELECT RAISE(ABORT,'Historical deliveries are immutable'); END;
CREATE TRIGGER deliveries_no_delete BEFORE DELETE ON deliveries BEGIN SELECT RAISE(ABORT,'Historical deliveries are immutable'); END;
CREATE TRIGGER observation_identity_immutable BEFORE UPDATE ON observations
WHEN NEW.id IS NOT OLD.id OR NEW.result_id IS NOT OLD.result_id OR NEW.organization_id IS NOT OLD.organization_id
 OR NEW.asset_id IS NOT OLD.asset_id OR NEW.content_version IS NOT OLD.content_version OR NEW.author_id IS NOT OLD.author_id OR NEW.created_at IS NOT OLD.created_at
BEGIN SELECT RAISE(ABORT,'An observation retains its exact image version and author'); END;
CREATE TRIGGER observation_version_forward BEFORE UPDATE ON observations
WHEN OLD.deleted_at IS NOT NULL OR NEW.version<>OLD.version+1
BEGIN SELECT RAISE(ABORT,'An observation requires one next version and cannot reopen after deletion'); END;
CREATE TRIGGER observations_no_delete BEFORE DELETE ON observations BEGIN SELECT RAISE(ABORT,'Observations retain a deletion tombstone'); END;
CREATE TRIGGER observation_events_no_update BEFORE UPDATE ON observation_events BEGIN SELECT RAISE(ABORT,'Observation history is append-only'); END;
CREATE TRIGGER observation_events_no_delete BEFORE DELETE ON observation_events BEGIN SELECT RAISE(ABORT,'Observation history is append-only'); END;
