delete from oauth_flows
where expires_at < :before
returning id
