-- Fetch one bundle by account + version (manifest download for sync).
select id, version, content_hash, r2_key, manifest, created_at
from config_bundles
where account_id = :accountId and version = :version
