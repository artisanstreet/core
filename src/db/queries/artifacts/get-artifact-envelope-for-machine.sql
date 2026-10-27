-- Release an artifact envelope to its assigned machine. Same-account on
-- both ends, assignment present, nothing revoked. The service decrypts
-- envelope_enc only after this row says yes; file bytes stay opaque.
with input as (
  select :artifact_id::text as artifact_id,
    :machine_id::text as machine_id,
    :account_id::text as account_id
)
select e.envelope_enc
from engine_artifacts e
join engine_artifact_assignments a on a.artifact_id = e.id
join machines m on m.id = a.machine_id
cross join input
where a.artifact_id = input.artifact_id
  and a.machine_id = input.machine_id
  and e.account_id = input.account_id
  and m.account_id = input.account_id
  and e.revoked_at is null
  and m.revoked_at is null
