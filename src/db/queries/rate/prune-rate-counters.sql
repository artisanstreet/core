-- Drop old rate buckets (janitor).
delete from rate_counters
where bucket_start <= :before
returning key
