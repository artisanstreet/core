-- Bookkeeping: is this migration version already applied?
select version from schema_migrations where version = $1
