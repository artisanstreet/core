-- Recent activity for an account, newest first (limit required).
select id, machine_id, kind, detail, ip, created_at
from activity_events
where account_id = :accountId
order by created_at desc
limit :limit::int
