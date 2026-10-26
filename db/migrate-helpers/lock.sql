-- Advisory transaction lock serializing concurrent migrators.
select pg_advisory_xact_lock(hashtext('ast-core-migrate')::bigint)
