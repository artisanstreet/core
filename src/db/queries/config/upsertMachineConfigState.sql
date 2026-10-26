-- Record which bundle a machine has applied (one row per machine).
-- Machine and bundle must both belong to the caller's account and be live;
-- the binding happens here in the mutation. Applied versions never move
-- backwards: on conflict the update requires the new bundle's version to be
-- at least the recorded one, so reordered or replayed reports cannot regress
-- a machine's revision. Zero rows means the binding failed (403) or the
-- report regresses (409); the service distinguishes them with follow-up reads.
with input as (
  select :machineId::text as machine_id,
    :bundleId::text as bundle_id,
    :status::text as status,
    :detail::text as detail,
    :accountId::text as account_id
)
insert into machine_config_state (machine_id, bundle_id, status, detail)
select input.machine_id, input.bundle_id, input.status, input.detail
from input
where exists (
  select 1 from machines m
  where m.id = input.machine_id
    and m.account_id = input.account_id
    and m.revoked_at is null
) and exists (
  select 1 from config_bundles b
  where b.id = input.bundle_id and b.account_id = input.account_id
)
on conflict (machine_id)
do update set bundle_id = excluded.bundle_id,
  status = excluded.status,
  detail = excluded.detail,
  applied_at = now()
where (select b.version from config_bundles b where b.id = excluded.bundle_id)
  >= (select b2.version
      from machine_config_state s
      join config_bundles b2 on b2.id = s.bundle_id
      where s.machine_id = excluded.machine_id)
returning machine_id, bundle_id, status, applied_at
