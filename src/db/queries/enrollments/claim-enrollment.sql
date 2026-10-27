-- Claim an enrollment into the authenticated account (atomic; pending only).
update enrollments
set status = 'claimed', account_id = :account_id, email = :email, claimed_at = now()
where id = :id and status = 'pending' and expires_at > now()
returning id, status, account_id
