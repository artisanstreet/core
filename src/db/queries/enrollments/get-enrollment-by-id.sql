-- Fetch an enrollment by id (holder of the enrollment key only, enforced by service).
select id, public_key_x, label, status, account_id, email,
  created_at, expires_at, claimed_at, confirmed_at, machine_id
from enrollments
where id = :id
