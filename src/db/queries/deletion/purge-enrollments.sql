-- Purge step: enrollments.
delete from enrollments
where account_id = :account_id
returning id
