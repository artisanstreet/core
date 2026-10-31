update oauth_flows
set status = :status,
  account_id = :account_id,
  subject = :subject,
  email = :email,
  display_name = :display_name,
  avatar_url = :avatar_url
where id = :id and status = 'exchanged'
returning id
