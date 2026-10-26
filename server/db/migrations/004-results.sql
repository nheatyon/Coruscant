CREATE TABLE result_sets (
  id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE, organization_id TEXT NOT NULL,
  accepted_quote_id TEXT NOT NULL, brief_revision INTEGER NOT NULL CHECK(brief_revision>0),
  material_version INTEGER NOT NULL CHECK(material_version>0), metadata_json TEXT NOT NULL CHECK(json_valid(metadata_json)),
  created_by TEXT NOT NULL REFERENCES actors(id), created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE(id,organization_id), UNIQUE(id,request_id,organization_id),
  FOREIGN KEY(accepted_quote_id,request_id,organization_id) REFERENCES quotes(id,request_id,organization_id),
  FOREIGN KEY(request_id,brief_revision) REFERENCES brief_revisions(request_id,revision)
) STRICT;
CREATE TABLE material_files (
  id TEXT PRIMARY KEY, relative_path TEXT NOT NULL UNIQUE CHECK(instr(relative_path,'/')=0 AND instr(relative_path,char(92))=0),
  sha256 TEXT NOT NULL, mime_type TEXT NOT NULL CHECK(mime_type='image/svg+xml'),
  byte_size INTEGER NOT NULL CHECK(byte_size>0), width INTEGER NOT NULL CHECK(width=1600), height INTEGER NOT NULL CHECK(height=1000),
  created_at TEXT NOT NULL
) STRICT;
CREATE TABLE image_assets (
  id TEXT PRIMARY KEY, result_id TEXT NOT NULL, organization_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('BASELINE','RECENT')), state TEXT NOT NULL CHECK(state IN ('REVIEW','PUBLISHED')),
  current_version INTEGER NOT NULL CHECK(current_version>0), published_version INTEGER, current_review_id TEXT, published_at TEXT, publish_reason TEXT,
  UNIQUE(result_id,role), UNIQUE(id,result_id,organization_id),
  FOREIGN KEY(result_id,organization_id) REFERENCES result_sets(id,organization_id),
  FOREIGN KEY(id,current_version) REFERENCES image_versions(asset_id,content_version) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(id,published_version) REFERENCES image_versions(asset_id,content_version) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(current_review_id) REFERENCES image_reviews(id) DEFERRABLE INITIALLY DEFERRED
) STRICT;
CREATE TABLE image_versions (
  asset_id TEXT NOT NULL, content_version INTEGER NOT NULL CHECK(content_version>0), result_id TEXT NOT NULL, organization_id TEXT NOT NULL,
  material_file_id TEXT NOT NULL REFERENCES material_files(id), metadata_json TEXT NOT NULL CHECK(json_valid(metadata_json)),
  created_by TEXT NOT NULL REFERENCES actors(id), created_at TEXT NOT NULL,
  PRIMARY KEY(asset_id,content_version), UNIQUE(asset_id,content_version,result_id,organization_id),
  FOREIGN KEY(asset_id,result_id,organization_id) REFERENCES image_assets(id,result_id,organization_id)
) STRICT;
CREATE TABLE image_reviews (
  id TEXT PRIMARY KEY, asset_id TEXT NOT NULL, content_version INTEGER NOT NULL, result_id TEXT NOT NULL, organization_id TEXT NOT NULL,
  reviewer_id TEXT NOT NULL REFERENCES actors(id), reviewed_at TEXT NOT NULL, reason TEXT NOT NULL CHECK(length(trim(reason))>0),
  validity_digest TEXT NOT NULL, facts_json TEXT NOT NULL CHECK(json_valid(facts_json)), date_snapshot_json TEXT NOT NULL CHECK(json_valid(date_snapshot_json)),
  discrepancy_acknowledged INTEGER NOT NULL CHECK(discrepancy_acknowledged IN (0,1)),
  FOREIGN KEY(asset_id,content_version,result_id,organization_id) REFERENCES image_versions(asset_id,content_version,result_id,organization_id)
) STRICT;
CREATE TABLE findings (
  id TEXT PRIMARY KEY, result_id TEXT NOT NULL UNIQUE, organization_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('DRAFT','REVIEW','PUBLISHED','WITHDRAWN')),
  current_version INTEGER NOT NULL CHECK(current_version>0), published_version INTEGER, current_review_id TEXT,
  created_by TEXT NOT NULL REFERENCES actors(id), created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  published_at TEXT, withdrawn_at TEXT, withdrawal_reason TEXT,
  UNIQUE(id,result_id,organization_id),
  FOREIGN KEY(result_id,organization_id) REFERENCES result_sets(id,organization_id),
  FOREIGN KEY(id,current_version) REFERENCES finding_versions(finding_id,content_version) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(id,published_version) REFERENCES finding_versions(finding_id,content_version) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(current_review_id) REFERENCES finding_reviews(id) DEFERRABLE INITIALLY DEFERRED
) STRICT;
CREATE TABLE finding_versions (
  finding_id TEXT NOT NULL, content_version INTEGER NOT NULL CHECK(content_version>0), result_id TEXT NOT NULL, organization_id TEXT NOT NULL,
  answer TEXT NOT NULL CHECK(length(trim(answer)) BETWEEN 1 AND 4000),
  limitations TEXT NOT NULL CHECK(length(trim(limitations)) BETWEEN 1 AND 2000), additional_sources TEXT NOT NULL CHECK(length(additional_sources)<=2000),
  created_by TEXT NOT NULL REFERENCES actors(id), created_at TEXT NOT NULL,
  PRIMARY KEY(finding_id,content_version), UNIQUE(finding_id,content_version,result_id,organization_id),
  FOREIGN KEY(finding_id,result_id,organization_id) REFERENCES findings(id,result_id,organization_id)
) STRICT;
CREATE TABLE finding_citations (
  finding_id TEXT NOT NULL, finding_version INTEGER NOT NULL, ordinal INTEGER NOT NULL CHECK(ordinal IN (1,2)),
  result_id TEXT NOT NULL, organization_id TEXT NOT NULL, asset_id TEXT NOT NULL, image_version INTEGER NOT NULL,
  PRIMARY KEY(finding_id,finding_version,ordinal), UNIQUE(finding_id,finding_version,asset_id),
  FOREIGN KEY(finding_id,finding_version,result_id,organization_id) REFERENCES finding_versions(finding_id,content_version,result_id,organization_id),
  FOREIGN KEY(asset_id,image_version,result_id,organization_id) REFERENCES image_versions(asset_id,content_version,result_id,organization_id)
) STRICT;
CREATE TABLE finding_reviews (
  id TEXT PRIMARY KEY, finding_id TEXT NOT NULL, content_version INTEGER NOT NULL, result_id TEXT NOT NULL, organization_id TEXT NOT NULL,
  reviewer_id TEXT NOT NULL REFERENCES actors(id), reviewed_at TEXT NOT NULL, reason TEXT NOT NULL,
  validity_digest TEXT NOT NULL, facts_json TEXT NOT NULL CHECK(json_valid(facts_json)), date_snapshot_json TEXT NOT NULL CHECK(json_valid(date_snapshot_json)), checklist_json TEXT NOT NULL CHECK(json_valid(checklist_json)),
  discrepancy_acknowledged INTEGER NOT NULL CHECK(discrepancy_acknowledged IN (0,1)),
  limitations_explain_date_discrepancy INTEGER NOT NULL CHECK(limitations_explain_date_discrepancy IN (0,1)),
  FOREIGN KEY(finding_id,content_version,result_id,organization_id) REFERENCES finding_versions(finding_id,content_version,result_id,organization_id)
) STRICT;
CREATE TABLE result_entitlements (
  result_id TEXT NOT NULL, organization_id TEXT NOT NULL, active INTEGER NOT NULL CHECK(active IN (0,1)),
  version INTEGER NOT NULL CHECK(version>0), expires_at TEXT, reason TEXT NOT NULL CHECK(length(trim(reason))>0),
  granted_by TEXT NOT NULL REFERENCES actors(id), granted_at TEXT NOT NULL,
  PRIMARY KEY(result_id,organization_id), FOREIGN KEY(result_id,organization_id) REFERENCES result_sets(id,organization_id)
) STRICT;
CREATE TABLE access_events (
  id TEXT PRIMARY KEY, result_id TEXT NOT NULL, organization_id TEXT NOT NULL, access_version INTEGER NOT NULL CHECK(access_version>0),
  actor_id TEXT NOT NULL REFERENCES actors(id), occurred_at TEXT NOT NULL, reason TEXT NOT NULL CHECK(length(trim(reason))>0),
  FOREIGN KEY(result_id,organization_id) REFERENCES result_sets(id,organization_id)
) STRICT;
CREATE TABLE material_events (
  id TEXT PRIMARY KEY, result_id TEXT NOT NULL, organization_id TEXT NOT NULL,
  actor_id TEXT NOT NULL REFERENCES actors(id), occurred_at TEXT NOT NULL, kind TEXT NOT NULL, reason TEXT NOT NULL,
  FOREIGN KEY(result_id,organization_id) REFERENCES result_sets(id,organization_id)
) STRICT;
CREATE TRIGGER result_association_immutable BEFORE UPDATE ON result_sets
WHEN NEW.id IS NOT OLD.id OR NEW.request_id IS NOT OLD.request_id OR NEW.organization_id IS NOT OLD.organization_id OR NEW.accepted_quote_id IS NOT OLD.accepted_quote_id OR NEW.brief_revision IS NOT OLD.brief_revision
BEGIN SELECT RAISE(ABORT,'Result accepted association is immutable'); END;
CREATE TRIGGER result_published_metadata_immutable BEFORE UPDATE ON result_sets
WHEN NEW.metadata_json IS NOT OLD.metadata_json AND (EXISTS(SELECT 1 FROM image_assets WHERE result_id=OLD.id AND published_version IS NOT NULL) OR EXISTS(SELECT 1 FROM findings WHERE result_id=OLD.id AND published_version IS NOT NULL))
BEGIN SELECT RAISE(ABORT,'Published result metadata is immutable'); END;
CREATE TRIGGER result_no_delete BEFORE DELETE ON result_sets BEGIN SELECT RAISE(ABORT,'Results retain their saved association'); END;
CREATE TRIGGER material_files_no_update BEFORE UPDATE ON material_files BEGIN SELECT RAISE(ABORT,'Registered material files are immutable'); END;
CREATE TRIGGER material_files_no_delete BEFORE DELETE ON material_files BEGIN SELECT RAISE(ABORT,'Registered material files are immutable'); END;
CREATE TRIGGER image_published_immutable BEFORE UPDATE ON image_assets WHEN OLD.published_version IS NOT NULL BEGIN SELECT RAISE(ABORT,'Published image association is immutable'); END;
CREATE TRIGGER image_identity_immutable BEFORE UPDATE ON image_assets WHEN NEW.id IS NOT OLD.id OR NEW.result_id IS NOT OLD.result_id OR NEW.organization_id IS NOT OLD.organization_id OR NEW.role IS NOT OLD.role BEGIN SELECT RAISE(ABORT,'Image identity is immutable'); END;
CREATE TRIGGER image_versions_no_update BEFORE UPDATE ON image_versions BEGIN SELECT RAISE(ABORT,'Image version snapshots are immutable'); END;
CREATE TRIGGER image_versions_no_delete BEFORE DELETE ON image_versions BEGIN SELECT RAISE(ABORT,'Image version snapshots are immutable'); END;
CREATE TRIGGER image_reviews_no_update BEFORE UPDATE ON image_reviews BEGIN SELECT RAISE(ABORT,'Actual image reviews are immutable'); END;
CREATE TRIGGER image_reviews_no_delete BEFORE DELETE ON image_reviews BEGIN SELECT RAISE(ABORT,'Actual image reviews are immutable'); END;
CREATE TRIGGER finding_published_content_immutable BEFORE UPDATE ON findings WHEN OLD.published_version IS NOT NULL AND (NEW.id IS NOT OLD.id OR NEW.result_id IS NOT OLD.result_id OR NEW.organization_id IS NOT OLD.organization_id OR NEW.current_version IS NOT OLD.current_version OR NEW.published_version IS NOT OLD.published_version OR NEW.current_review_id IS NOT OLD.current_review_id OR NEW.published_at IS NOT OLD.published_at) BEGIN SELECT RAISE(ABORT,'Published finding content association is immutable'); END;
CREATE TRIGGER finding_state_transition BEFORE UPDATE ON findings WHEN (OLD.state IN ('PUBLISHED','WITHDRAWN') AND NOT(OLD.state='PUBLISHED' AND NEW.state IN ('PUBLISHED','WITHDRAWN') OR OLD.state='WITHDRAWN' AND NEW.state='WITHDRAWN')) BEGIN SELECT RAISE(ABORT,'Published findings cannot reopen as drafts'); END;
CREATE TRIGGER finding_versions_no_update BEFORE UPDATE ON finding_versions BEGIN SELECT RAISE(ABORT,'Finding version snapshots are immutable'); END;
CREATE TRIGGER finding_versions_no_delete BEFORE DELETE ON finding_versions BEGIN SELECT RAISE(ABORT,'Finding version snapshots are immutable'); END;
CREATE TRIGGER finding_citations_no_update BEFORE UPDATE ON finding_citations BEGIN SELECT RAISE(ABORT,'Exact finding citations are immutable'); END;
CREATE TRIGGER finding_citations_no_delete BEFORE DELETE ON finding_citations BEGIN SELECT RAISE(ABORT,'Exact finding citations are immutable'); END;
CREATE TRIGGER finding_reviews_no_update BEFORE UPDATE ON finding_reviews BEGIN SELECT RAISE(ABORT,'Actual finding reviews are immutable'); END;
CREATE TRIGGER finding_reviews_no_delete BEFORE DELETE ON finding_reviews BEGIN SELECT RAISE(ABORT,'Actual finding reviews are immutable'); END;
CREATE TRIGGER material_events_no_update BEFORE UPDATE ON material_events BEGIN SELECT RAISE(ABORT,'Material history is append-only'); END;
CREATE TRIGGER material_events_no_delete BEFORE DELETE ON material_events BEGIN SELECT RAISE(ABORT,'Material history is append-only'); END;
CREATE TRIGGER access_events_no_update BEFORE UPDATE ON access_events BEGIN SELECT RAISE(ABORT,'Access history is append-only'); END;
CREATE TRIGGER access_events_no_delete BEFORE DELETE ON access_events BEGIN SELECT RAISE(ABORT,'Access history is append-only'); END;
