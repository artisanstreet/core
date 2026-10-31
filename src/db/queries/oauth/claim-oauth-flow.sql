update oauth_flows
set status = 'exchanged'
where id = :id
  and state_hash = :state_hash
  and flow_secret_hash = :flow_secret_hash
  and status = 'started'
  and expires_at > :now
returning id, provider, intent, account_id, verifier_enc, redirect_uri
