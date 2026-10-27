-- Durable replay dedup: succeeds only for a fresh (subject, nonce).
-- A conflicting row means a replay (or retry) and inserts nothing.
insert into machine_nonces (subject, nonce)
values (:subject, :nonce)
on conflict do nothing
returning subject
