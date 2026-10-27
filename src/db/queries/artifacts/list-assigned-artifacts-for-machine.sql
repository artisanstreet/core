-- Artifacts assigned to one live machine (discovery for sync).
-- Same-account on both ends, assignment present, nothing revoked.
-- Metadata only; envelopes are never listed (see getArtifactEnvelopeForMachine).
with input as (
  select :machine_id::text as machine_id,
    :account_id::text as account_id
)
select e.id, e.engine, e.kind, e.label, e.format_version,
  e.exported_at, e.created_at, e.revoked_at
from engine_artifacts e
join engine_artifact_assignments a on a.artifact_id = e.id
join machines m on m.id = a.machine_id
cross join input
where a.machine_id = input.machine_id
  and e.account_id = input.account_id
  and m.account_id = input.account_id
  and e.revoked_at is null
  and m.revoked_at is null
order by e.created_at desc
