-- Confirm an enrollment: bind the exact account+key (atomic; claimed only).
update enrollments
set status = 'confirmed', confirmed_at = now(), machine_id = :machine_id
where id = :id and status = 'claimed' and account_id = :account_id and expires_at > now()
returning id, status, account_id, machine_id, public_key_x
