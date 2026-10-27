-- All artifact assignments in an account (for listings).
select a.artifact_id, a.machine_id
from engine_artifact_assignments a
join engine_artifacts e on e.id = a.artifact_id
where e.account_id = :account_id
