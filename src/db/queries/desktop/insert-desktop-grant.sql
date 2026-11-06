insert into desktop_grants
  (code_hash, challenge, account_id, totp_verified, expires_at)
values
  (:code_hash, :challenge, :account_id, :totp_verified, :expires_at)
returning code_hash
