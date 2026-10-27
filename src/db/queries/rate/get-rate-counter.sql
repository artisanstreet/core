-- Read a rate-limit bucket (missing bucket means zero).
select count
from rate_counters
where key = :key and bucket_start = :bucket_start
