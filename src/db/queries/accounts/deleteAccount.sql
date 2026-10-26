-- Final account row removal (data tables are purged first by the service).
delete from accounts
where id = :id
returning id
