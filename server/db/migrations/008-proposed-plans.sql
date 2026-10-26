-- Forward-only C13/C14 artifacts and selected plans. Existing workflow JSON is untouched.
CREATE TABLE orbital_assessments (
 id TEXT PRIMARY KEY, generation INTEGER NOT NULL CHECK(generation>0),
 owner_cookie_hash TEXT NOT NULL, owner_generation INTEGER NOT NULL CHECK(owner_generation>0),
 audience TEXT NOT NULL CHECK(audience IN ('PUBLIC','CUSTOMER','STAFF')),
 actor_id TEXT REFERENCES actors(id), organization_id TEXT REFERENCES organizations(id), request_id TEXT,
 input_digest TEXT NOT NULL, brief_digest TEXT NOT NULL,
 snapshot_version TEXT NOT NULL, fact_version TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('QUEUED','RUNNING','COMPLETE','INCOMPLETE','CANCELED','INTERRUPTED','FAILED')),
 created_at TEXT NOT NULL, started_at TEXT, completed_at TEXT, attachment_expires_at TEXT,
 read_capability_hash TEXT NOT NULL, manifest_digest TEXT, manifest_bytes INTEGER CHECK(manifest_bytes IS NULL OR manifest_bytes BETWEEN 1 AND 33554432),
 manifest_filename TEXT, summary_json TEXT CHECK(summary_json IS NULL OR json_valid(summary_json)),
 CHECK(request_id IS NULL OR organization_id IS NOT NULL),
 UNIQUE(id,manifest_digest),
 FOREIGN KEY(request_id,organization_id) REFERENCES service_requests(id,organization_id)
) STRICT;
CREATE INDEX orbital_assessments_by_owner ON orbital_assessments(owner_cookie_hash,owner_generation);
CREATE TRIGGER assessment_calculation_identity BEFORE UPDATE ON orbital_assessments
 WHEN NEW.id IS NOT OLD.id OR NEW.generation IS NOT OLD.generation OR NEW.input_digest IS NOT OLD.input_digest
 OR NEW.brief_digest IS NOT OLD.brief_digest OR NEW.snapshot_version IS NOT OLD.snapshot_version OR NEW.fact_version IS NOT OLD.fact_version
 OR NEW.created_at IS NOT OLD.created_at
 OR (OLD.manifest_digest IS NOT NULL AND (NEW.manifest_digest IS NOT OLD.manifest_digest OR NEW.manifest_bytes IS NOT OLD.manifest_bytes
 OR NEW.manifest_filename IS NOT OLD.manifest_filename OR NEW.completed_at IS NOT OLD.completed_at OR NEW.attachment_expires_at IS NOT OLD.attachment_expires_at))
 BEGIN SELECT RAISE(ABORT,'Calculated artifact identity is immutable'); END;

CREATE TABLE proposed_plan_versions (
 id TEXT PRIMARY KEY, request_id TEXT NOT NULL, organization_id TEXT NOT NULL,
 version INTEGER NOT NULL CHECK(version>0), brief_revision INTEGER NOT NULL CHECK(brief_revision>0),
 assessment_id TEXT NOT NULL, manifest_digest TEXT NOT NULL, option_id TEXT NOT NULL,
 input_digest TEXT NOT NULL, selection_digest TEXT NOT NULL,
 selection_json TEXT NOT NULL CHECK(json_valid(selection_json)),
 created_at TEXT NOT NULL, actor_id TEXT NOT NULL REFERENCES actors(id),
 UNIQUE(request_id,version), UNIQUE(id,request_id,organization_id),
 FOREIGN KEY(request_id,organization_id) REFERENCES service_requests(id,organization_id),
 FOREIGN KEY(request_id,brief_revision) REFERENCES brief_revisions(request_id,revision),
 FOREIGN KEY(assessment_id,manifest_digest) REFERENCES orbital_assessments(id,manifest_digest)
) STRICT;
CREATE TRIGGER proposed_plan_no_update BEFORE UPDATE ON proposed_plan_versions
 BEGIN SELECT RAISE(ABORT,'Proposed plan versions are immutable'); END;
CREATE TRIGGER proposed_plan_no_delete BEFORE DELETE ON proposed_plan_versions
 BEGIN SELECT RAISE(ABORT,'Proposed plan history cannot be deleted'); END;
CREATE TRIGGER proposed_plan_before_acceptance BEFORE INSERT ON proposed_plan_versions
 WHEN EXISTS(SELECT 1 FROM service_requests r WHERE r.id=NEW.request_id AND r.accepted_quote_id IS NOT NULL)
 BEGIN SELECT RAISE(ABORT,'Accepted planning work is immutable'); END;

CREATE TABLE proposed_plan_invalidations (
 plan_version_id TEXT PRIMARY KEY REFERENCES proposed_plan_versions(id),
 request_id TEXT NOT NULL, organization_id TEXT NOT NULL, brief_revision INTEGER NOT NULL,
 invalidated_at TEXT NOT NULL, reason TEXT NOT NULL CHECK(length(trim(reason))>0),
 actor_id TEXT NOT NULL REFERENCES actors(id),
 FOREIGN KEY(plan_version_id,request_id,organization_id) REFERENCES proposed_plan_versions(id,request_id,organization_id),
 FOREIGN KEY(request_id,brief_revision) REFERENCES brief_revisions(request_id,revision)
) STRICT;
CREATE TRIGGER plan_invalidation_no_update BEFORE UPDATE ON proposed_plan_invalidations
 BEGIN SELECT RAISE(ABORT,'Plan invalidation history is immutable'); END;
CREATE TRIGGER plan_invalidation_no_delete BEFORE DELETE ON proposed_plan_invalidations
 BEGIN SELECT RAISE(ABORT,'Plan invalidation history cannot be deleted'); END;
CREATE TRIGGER plan_invalidation_before_acceptance BEFORE INSERT ON proposed_plan_invalidations
 WHEN EXISTS(SELECT 1 FROM service_requests r WHERE r.id=NEW.request_id AND r.accepted_quote_id IS NOT NULL)
 BEGIN SELECT RAISE(ABORT,'Accepted plan cannot be invalidated'); END;

CREATE TABLE request_proposed_plan_state (
 request_id TEXT PRIMARY KEY, organization_id TEXT NOT NULL,
 current_plan_id TEXT, accepted_frozen INTEGER NOT NULL DEFAULT 0 CHECK(accepted_frozen IN (0,1)),
 accepted_plan_id TEXT, accepted_quote_id TEXT, accepted_at TEXT,
 CHECK((accepted_frozen=0 AND accepted_plan_id IS NULL AND accepted_quote_id IS NULL AND accepted_at IS NULL)
 OR (accepted_frozen=1 AND accepted_quote_id IS NOT NULL AND accepted_at IS NOT NULL AND current_plan_id IS accepted_plan_id)),
 FOREIGN KEY(request_id,organization_id) REFERENCES service_requests(id,organization_id),
 FOREIGN KEY(current_plan_id,request_id,organization_id) REFERENCES proposed_plan_versions(id,request_id,organization_id),
 FOREIGN KEY(accepted_plan_id,request_id,organization_id) REFERENCES proposed_plan_versions(id,request_id,organization_id),
 FOREIGN KEY(accepted_quote_id,request_id,organization_id) REFERENCES quotes(id,request_id,organization_id)
) STRICT;
CREATE TRIGGER plan_state_identity BEFORE UPDATE ON request_proposed_plan_state
 WHEN NEW.request_id IS NOT OLD.request_id OR NEW.organization_id IS NOT OLD.organization_id OR OLD.accepted_frozen=1
 BEGIN SELECT RAISE(ABORT,'Accepted plan binding and request identity are immutable'); END;
CREATE TRIGGER plan_state_no_delete BEFORE DELETE ON request_proposed_plan_state
 BEGIN SELECT RAISE(ABORT,'Plan binding history cannot be deleted'); END;
CREATE TRIGGER plan_state_current_valid_insert BEFORE INSERT ON request_proposed_plan_state
 WHEN NEW.current_plan_id IS NOT NULL AND EXISTS(SELECT 1 FROM proposed_plan_invalidations i WHERE i.plan_version_id=NEW.current_plan_id)
 BEGIN SELECT RAISE(ABORT,'An invalidated plan cannot be current'); END;
CREATE TRIGGER plan_state_current_valid_update BEFORE UPDATE ON request_proposed_plan_state
 WHEN NEW.current_plan_id IS NOT NULL AND EXISTS(SELECT 1 FROM proposed_plan_invalidations i WHERE i.plan_version_id=NEW.current_plan_id)
 BEGIN SELECT RAISE(ABORT,'An invalidated plan cannot be current'); END;
CREATE TRIGGER plan_state_acceptance_insert BEFORE INSERT ON request_proposed_plan_state
 WHEN NEW.accepted_frozen=1 AND NOT EXISTS(SELECT 1 FROM service_requests r WHERE r.id=NEW.request_id AND r.accepted_quote_id=NEW.accepted_quote_id)
 BEGIN SELECT RAISE(ABORT,'Plan freeze must accompany the exact acceptance'); END;
CREATE TRIGGER plan_state_acceptance_update BEFORE UPDATE ON request_proposed_plan_state
 WHEN NEW.accepted_frozen=1 AND NOT EXISTS(SELECT 1 FROM service_requests r WHERE r.id=NEW.request_id AND r.accepted_quote_id=NEW.accepted_quote_id)
 BEGIN SELECT RAISE(ABORT,'Plan freeze must accompany the exact acceptance'); END;

CREATE TABLE orbital_assessment_attachments (
 assessment_id TEXT NOT NULL, manifest_digest TEXT NOT NULL,
 request_id TEXT NOT NULL, organization_id TEXT NOT NULL, brief_revision INTEGER NOT NULL,
 plan_version_id TEXT NOT NULL UNIQUE, attached_at TEXT NOT NULL,
 FOREIGN KEY(assessment_id,manifest_digest) REFERENCES orbital_assessments(id,manifest_digest),
 FOREIGN KEY(request_id,organization_id) REFERENCES service_requests(id,organization_id),
 FOREIGN KEY(request_id,brief_revision) REFERENCES brief_revisions(request_id,revision),
 FOREIGN KEY(plan_version_id,request_id,organization_id) REFERENCES proposed_plan_versions(id,request_id,organization_id)
) STRICT;
CREATE TRIGGER assessment_attachment_no_update BEFORE UPDATE ON orbital_assessment_attachments
 BEGIN SELECT RAISE(ABORT,'Saved assessment association is immutable'); END;
CREATE TRIGGER assessment_attachment_no_delete BEFORE DELETE ON orbital_assessment_attachments
 BEGIN SELECT RAISE(ABORT,'Saved assessment association cannot be deleted'); END;

CREATE TABLE orbital_assessment_handoffs (
 nonce_hash TEXT PRIMARY KEY, assessment_id TEXT NOT NULL REFERENCES orbital_assessments(id),
 phase TEXT NOT NULL CHECK(phase IN ('PREPARED','ENTERED','CONSUMED')),
 from_cookie_hash TEXT NOT NULL, from_generation INTEGER NOT NULL CHECK(from_generation>0),
 entered_cookie_hash TEXT, entered_generation INTEGER CHECK(entered_generation IS NULL OR entered_generation>0),
 actor_id TEXT REFERENCES actors(id), expires_at TEXT NOT NULL, continuation_hash TEXT
) STRICT;

CREATE TABLE proposed_plan_reviews (
 token_hash TEXT PRIMARY KEY REFERENCES command_reviews(token_hash),
 prepared_json TEXT NOT NULL CHECK(json_valid(prepared_json)),
 brief_json TEXT NOT NULL CHECK(json_valid(brief_json)),
 evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)),
 matching_state TEXT NOT NULL CHECK(matching_state IN ('Preliminary check ready','Automatic check unavailable'))
) STRICT;
CREATE TRIGGER proposed_plan_review_no_update BEFORE UPDATE ON proposed_plan_reviews
 BEGIN SELECT RAISE(ABORT,'Prepared plan confirmation is immutable'); END;
