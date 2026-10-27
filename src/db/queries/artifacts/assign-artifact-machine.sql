-- Assign an artifact to a machine. Both ends must belong to the caller's
-- account and be live; the account binding happens here in the mutation.
with input as (
  select :artifact_id::text as artifact_id,
    :machine_id::text as machine_id,
    :account_id::text as account_id
)
insert into engine_artifact_assignments (artifact_id, machine_id)
select input.artifact_id, input.machine_id
from input
where exists (
  select 1 from engine_artifacts e
  where e.id = input.artifact_id
    and e.account_id = input.account_id
    and e.revoked_at is null
) and exists (
  select 1 from machines m
  where m.id = input.machine_id
    and m.account_id = input.account_id
    and m.revoked_at is null
)
on conflict do nothing
returning artifact_id, machine_id
