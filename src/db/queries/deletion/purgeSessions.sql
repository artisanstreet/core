-- Purge step: sessions.
delete from sessions
where account_id = :accountId
returning id
