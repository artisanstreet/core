-- Refresh last-seen on authenticated machine activity.
update machines
set last_seen_at = now()
where id = :id
returning id
