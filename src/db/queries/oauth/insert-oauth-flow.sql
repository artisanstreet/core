insert into oauth_flows
  (id, provider, intent, account_id, state_hash, flow_secret_hash, verifier_enc, redirect_uri, expires_at)
values
  (:id, :provider, :intent, :account_id, :state_hash, :flow_secret_hash, :verifier_enc, :redirect_uri, :expires_at)
returning id
