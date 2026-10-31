select id, provider, account_id, status, expires_at
from oauth_flows
where id = :id and flow_secret_hash = :flow_secret_hash
