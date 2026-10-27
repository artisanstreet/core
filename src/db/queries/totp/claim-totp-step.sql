-- Claim a TOTP time-step for single-use. A conflicting row means this
-- exact code was already consumed: the replay is rejected.
insert into totp_used_steps (account_id, step)
values (:account_id, :step)
on conflict do nothing
returning step
