-- Drop old nonce rows (janitor; window is enforced by timestamps).
delete from machine_nonces
where created_at <= :before
returning subject
