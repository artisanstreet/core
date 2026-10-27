-- Consume one recovery code (atomic; unused only).
update recovery_codes
set used_at = now()
where account_id = :account_id and code_hash = :code_hash and used_at is null
returning id
