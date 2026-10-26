-- Count unused recovery codes (never list hashes to callers).
select count(*)::int as n
from recovery_codes
where account_id = :accountId and used_at is null
