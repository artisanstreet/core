-- Fetch one bundle by id, account-bound (for precise 403/409 on reports).
select id, account_id, version, content_hash, r2_key, created_at
from config_bundles
where id = :id and account_id = :accountId
