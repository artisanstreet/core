-- Read a machine's applied revision (account-bound through the machine).
select s.machine_id, s.bundle_id, s.status, s.detail, s.applied_at,
  b.version, b.content_hash
from machine_config_state s
join machines m on m.id = s.machine_id
join config_bundles b on b.id = s.bundle_id
where s.machine_id = :machine_id and m.account_id = :account_id
