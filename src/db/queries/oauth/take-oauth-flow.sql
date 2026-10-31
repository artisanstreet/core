update oauth_flows
set status = 'completed'
where id = :id
  and flow_secret_hash = :flow_secret_hash
  and status = :status
  and expires_at > :now
returning id, provider, account_id, subject, email, display_name, avatar_url
