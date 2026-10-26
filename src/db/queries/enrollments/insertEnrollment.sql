-- Start a Forge machine enrollment (proof-of-possession verified by service).
insert into enrollments
  (id, public_key_x, label, code_hash, status, expires_at)
values
  (:id, :publicKeyX, :label, :codeHash, 'pending', :expiresAt)
returning id, expires_at
