-- Consume one recovery code (atomic; unused only).
update recovery_codes
set used_at = now()
where account_id = :accountId and code_hash = :codeHash and used_at is null
returning id
