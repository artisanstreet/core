-- Bookkeeping: record an applied migration version.
insert into schema_migrations (version) values ($1)
