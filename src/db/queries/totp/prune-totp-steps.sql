-- Drop old consumed TOTP steps (janitor; steps are single-use within minutes).
delete from totp_used_steps
where created_at <= :before
returning account_id
