CREATE TABLE orbital_source_state (
 source_key TEXT PRIMARY KEY CHECK(source_key IN ('sar','resource')),
 attempted_at TEXT, next_allowed_at TEXT, checked_at TEXT, error TEXT,
 current_view TEXT, last_source_version TEXT
) STRICT;
CREATE TABLE orbital_source_attempts (
 id TEXT PRIMARY KEY, source_key TEXT NOT NULL CHECK(source_key IN ('sar','resource')),
 attempted_at TEXT NOT NULL, next_allowed_at TEXT NOT NULL,
 outcome TEXT NOT NULL, http_status INTEGER, error TEXT, response_hash TEXT
) STRICT;
CREATE TABLE orbital_source_versions (
 version TEXT PRIMARY KEY, source_key TEXT NOT NULL CHECK(source_key IN ('sar','resource')),
 response_hash TEXT NOT NULL, raw_filename TEXT NOT NULL, retrieved_at TEXT NOT NULL,
 parsed_json TEXT NOT NULL CHECK(json_valid(parsed_json))
) STRICT;
CREATE TABLE orbital_group_views (
 version TEXT PRIMARY KEY, source_key TEXT NOT NULL, source_version TEXT NOT NULL REFERENCES orbital_source_versions(version),
 view_json TEXT NOT NULL CHECK(json_valid(view_json))
) STRICT;
CREATE TABLE orbital_catalog_snapshots (
 version TEXT PRIMARY KEY, fact_version TEXT NOT NULL, created_at TEXT NOT NULL,
 snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)), elements_json TEXT NOT NULL CHECK(json_valid(elements_json))
) STRICT;
CREATE TABLE orbital_catalog_current (singleton INTEGER PRIMARY KEY CHECK(singleton=1), version TEXT NOT NULL REFERENCES orbital_catalog_snapshots(version)) STRICT;
CREATE TABLE orbital_evidence_versions (
 item_id TEXT NOT NULL, evidence_version TEXT NOT NULL, item_json TEXT NOT NULL CHECK(json_valid(item_json)),
 PRIMARY KEY(item_id,evidence_version)
) STRICT;
CREATE TABLE orbital_initial_ledger (digest TEXT PRIMARY KEY, adopted_at TEXT NOT NULL) STRICT;
CREATE TRIGGER immutable_orbital_source_update BEFORE UPDATE ON orbital_source_versions BEGIN SELECT RAISE(ABORT,'immutable source version'); END;
CREATE TRIGGER immutable_orbital_source_delete BEFORE DELETE ON orbital_source_versions BEGIN SELECT RAISE(ABORT,'immutable source version'); END;
CREATE TRIGGER immutable_orbital_view_update BEFORE UPDATE ON orbital_group_views BEGIN SELECT RAISE(ABORT,'immutable group view'); END;
CREATE TRIGGER immutable_orbital_view_delete BEFORE DELETE ON orbital_group_views BEGIN SELECT RAISE(ABORT,'immutable group view'); END;
CREATE TRIGGER immutable_orbital_snapshot_update BEFORE UPDATE ON orbital_catalog_snapshots BEGIN SELECT RAISE(ABORT,'immutable catalog snapshot'); END;
CREATE TRIGGER immutable_orbital_snapshot_delete BEFORE DELETE ON orbital_catalog_snapshots BEGIN SELECT RAISE(ABORT,'immutable catalog snapshot'); END;
CREATE TRIGGER immutable_real_evidence_update BEFORE UPDATE ON orbital_evidence_versions BEGIN SELECT RAISE(ABORT,'immutable real evidence'); END;
CREATE TRIGGER immutable_real_evidence_delete BEFORE DELETE ON orbital_evidence_versions BEGIN SELECT RAISE(ABORT,'immutable real evidence'); END;
CREATE TABLE orbital_object_versions (
 version TEXT PRIMARY KEY, item_id TEXT NOT NULL, orbital_hash TEXT, epoch TEXT, source_epoch TEXT,
 object_json TEXT NOT NULL CHECK(json_valid(object_json))
) STRICT;
CREATE TABLE orbital_membership_versions (
 view_version TEXT NOT NULL REFERENCES orbital_group_views(version), item_id TEXT NOT NULL,
 source_version TEXT NOT NULL REFERENCES orbital_source_versions(version), row_hash TEXT NOT NULL,
 confirmation TEXT NOT NULL CHECK(confirmation IN ('CONFIRMED','UNCONFIRMED')), last_seen_at TEXT NOT NULL,
 identity_json TEXT NOT NULL CHECK(json_valid(identity_json)),
 PRIMARY KEY(view_version,item_id,source_version,row_hash)
) STRICT;
CREATE TABLE orbital_capability_fact_versions (
 fact_id TEXT NOT NULL, version TEXT NOT NULL, item_id TEXT NOT NULL,
 fact_json TEXT NOT NULL CHECK(json_valid(fact_json)), PRIMARY KEY(fact_id,version)
) STRICT;
CREATE TRIGGER immutable_orbital_object_update BEFORE UPDATE ON orbital_object_versions BEGIN SELECT RAISE(ABORT,'immutable object version'); END;
CREATE TRIGGER immutable_orbital_object_delete BEFORE DELETE ON orbital_object_versions BEGIN SELECT RAISE(ABORT,'immutable object version'); END;
CREATE TRIGGER immutable_orbital_membership_update BEFORE UPDATE ON orbital_membership_versions BEGIN SELECT RAISE(ABORT,'immutable membership version'); END;
CREATE TRIGGER immutable_orbital_membership_delete BEFORE DELETE ON orbital_membership_versions BEGIN SELECT RAISE(ABORT,'immutable membership version'); END;
CREATE TRIGGER immutable_orbital_capability_update BEFORE UPDATE ON orbital_capability_fact_versions BEGIN SELECT RAISE(ABORT,'immutable capability version'); END;
CREATE TRIGGER immutable_orbital_capability_delete BEFORE DELETE ON orbital_capability_fact_versions BEGIN SELECT RAISE(ABORT,'immutable capability version'); END;
