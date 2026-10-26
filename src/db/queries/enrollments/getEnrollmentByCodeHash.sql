-- Find a live enrollment by code hash (claim path).
select id, public_key_x, label, status, account_id, email,
  created_at, expires_at, claimed_at, confirmed_at, machine_id
from enrollments
where code_hash = :codeHash
