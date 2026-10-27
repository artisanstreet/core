-- Create a persistent session (token hash only; raw token never stored).
insert into sessions
  (id, account_id, token_hash, device_name, ip, user_agent, totp_verified_at, expires_at)
values
  (:id, :account_id, :token_hash, :device_name, :ip, :user_agent, :totp_verified_at, :expires_at)
returning id, account_id, created_at, expires_at
