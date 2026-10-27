-- Void an enrollment (abuse or operator cancel).
update enrollments
set status = 'voided'
where id = :id and status in ('pending', 'claimed')
returning id
