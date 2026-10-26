-- Purge step: enrollments.
delete from enrollments
where account_id = :accountId
returning id
