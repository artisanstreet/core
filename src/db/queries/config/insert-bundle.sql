-- Publish one bundle attempt: the version is max+1 computed atomically in
-- the same statement, and any uniqueness conflict (concurrent same version,
-- or identical content via the per-account content hash) inserts nothing
-- instead of raising. Zero rows means retry-or-dedup; the service re-reads
-- latest to tell a version race (retry with a fresh id) from identical
-- content (return the existing revision). No error-shape inspection needed.
with input as (
  select :id::text as id,
    :account_id::text as account_id,
    :content_hash::text as content_hash,
    :r2_key::text as r2_key,
    :manifest::jsonb as manifest
)
insert into config_bundles (id, account_id, version, content_hash, r2_key, manifest)
select input.id, input.account_id,
  (select coalesce(max(version), 0) + 1 from config_bundles where account_id = input.account_id),
  input.content_hash, input.r2_key, input.manifest
from input
on conflict do nothing
returning id, version, r2_key, created_at
