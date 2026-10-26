-- Remove an artifact assignment (account-bound through the artifact row).
delete from engine_artifact_assignments a
using engine_artifacts e
where a.artifact_id = :artifactId and a.machine_id = :machineId
  and a.artifact_id = e.id and e.account_id = :accountId
returning a.artifact_id, a.machine_id
