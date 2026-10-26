-- Forward-only bounded parent rebuild. The migration runner disables FK enforcement
-- outside this transaction, validates every preserved relationship, then restores it.
CREATE TABLE service_requests_planning (
 id TEXT PRIMARY KEY, reference TEXT NOT NULL UNIQUE,
 organization_id TEXT NOT NULL REFERENCES organizations(id),
 original_actor_id TEXT NOT NULL REFERENCES actors(id),
 original_contact_json TEXT CHECK(original_contact_json IS NULL OR json_valid(original_contact_json)),
 submitted_at TEXT, submitted_actor_id TEXT REFERENCES actors(id), first_saved_at TEXT NOT NULL,
 title TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('Planning','Submitted','In review','Needs information','Quote ready','Accepted','Scheduled','Delivered')),
 aggregate_version INTEGER NOT NULL CHECK(aggregate_version>0),
 current_brief_revision INTEGER NOT NULL CHECK(current_brief_revision>0),
 matching_state TEXT NOT NULL CHECK(matching_state IN ('Preliminary check ready','Automatic check unavailable')),
 current_published_quote_id TEXT REFERENCES quotes(id), accepted_quote_id TEXT REFERENCES quotes(id),
 CHECK((status='Planning' AND submitted_at IS NULL AND submitted_actor_id IS NULL AND original_contact_json IS NULL AND current_published_quote_id IS NULL AND accepted_quote_id IS NULL) OR
       (status<>'Planning' AND submitted_at IS NOT NULL AND submitted_actor_id IS NOT NULL AND original_contact_json IS NOT NULL)),
 UNIQUE(id,organization_id)
) STRICT;
INSERT INTO service_requests_planning(id,reference,organization_id,original_actor_id,original_contact_json,submitted_at,submitted_actor_id,first_saved_at,title,status,aggregate_version,current_brief_revision,matching_state,current_published_quote_id,accepted_quote_id)
 SELECT id,reference,organization_id,original_actor_id,original_contact_json,submitted_at,original_actor_id,submitted_at,title,status,aggregate_version,current_brief_revision,matching_state,current_published_quote_id,accepted_quote_id FROM service_requests;
DROP TABLE service_requests;
ALTER TABLE service_requests_planning RENAME TO service_requests;
CREATE INDEX requests_by_org ON service_requests(organization_id,first_saved_at DESC,id);
CREATE TRIGGER request_identity_no_change BEFORE UPDATE ON service_requests
 WHEN NEW.id IS NOT OLD.id OR NEW.reference IS NOT OLD.reference OR NEW.organization_id IS NOT OLD.organization_id OR NEW.original_actor_id IS NOT OLD.original_actor_id OR NEW.first_saved_at IS NOT OLD.first_saved_at
 OR (OLD.submitted_at IS NOT NULL AND (NEW.original_contact_json IS NOT OLD.original_contact_json OR NEW.submitted_at IS NOT OLD.submitted_at OR NEW.submitted_actor_id IS NOT OLD.submitted_actor_id))
 BEGIN SELECT RAISE(ABORT,'Original request and actual submission identity are immutable'); END;
CREATE TRIGGER request_submission_once BEFORE UPDATE ON service_requests
 WHEN (OLD.status<>'Planning' AND NEW.status='Planning') OR (OLD.submitted_at IS NULL AND NEW.submitted_at IS NOT NULL AND (OLD.status<>'Planning' OR NEW.status<>'Submitted'))
 BEGIN SELECT RAISE(ABORT,'Planning must be explicitly submitted once'); END;
CREATE TRIGGER accepted_request_association BEFORE UPDATE ON service_requests
 WHEN OLD.accepted_quote_id IS NOT NULL AND (NEW.accepted_quote_id IS NOT OLD.accepted_quote_id OR NEW.current_brief_revision IS NOT OLD.current_brief_revision)
 BEGIN SELECT RAISE(ABORT,'Accepted request association is immutable'); END;
