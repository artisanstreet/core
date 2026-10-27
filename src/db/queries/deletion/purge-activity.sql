-- Purge step: activity (no FK into it, delete first).
delete from activity_events
where account_id = :account_id
returning id
