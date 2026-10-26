-- Increment a rate-limit bucket (per key, fixed window start), creating it.
insert into rate_counters (key, bucket_start, count)
values (:key, :bucketStart, 1)
on conflict (key, bucket_start)
do update set count = rate_counters.count + 1
returning count
