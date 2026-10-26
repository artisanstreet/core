-- Store an engine credential artifact: the envelope is encrypted by the
-- service. Core validates the envelope SHAPE; inner file bytes stay opaque.
-- Core performs no OAuth: artifacts come from the harness's own local login.
insert into engine_artifacts
  (id, account_id, engine, kind, label, format_version, envelope_enc, exported_at)
values
  (:id, :accountId, :engine, :kind, :label, :formatVersion, :envelopeEnc, :exportedAt)
returning id, engine, kind, label, format_version, exported_at, created_at
