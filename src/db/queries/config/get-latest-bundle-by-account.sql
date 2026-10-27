-- Latest bundle of an account (null when none published yet).
select id, version, content_hash, r2_key, manifest, created_at
from config_bundles
where account_id = :account_id
order by version desc
limit 1
