-- Remove an artifact assignment (account-bound through the artifact row).
delete from engine_artifact_assignments a
using engine_artifacts e
where a.artifact_id = :artifact_id and a.machine_id = :machine_id
  and a.artifact_id = e.id and e.account_id = :account_id
returning a.artifact_id, a.machine_id
