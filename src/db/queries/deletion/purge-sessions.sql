-- Purge step: sessions.
delete from sessions
where account_id = :account_id
returning id
