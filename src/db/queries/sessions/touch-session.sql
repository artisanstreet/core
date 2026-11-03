update sessions
set last_seen_at = :seen_at::timestamptz, country_code = coalesce(nullif(:country_code::text, ''), country_code)
where id = :id and revoked_at is null
  and (last_seen_at is null or last_seen_at < :cutoff::timestamptz or (country_code is null and :country_missing::boolean))
