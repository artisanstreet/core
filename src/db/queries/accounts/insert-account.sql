-- Insert a new account; email is the verified login identity.
insert into accounts (id, email, display_name, avatar_url)
values (:id, :email, :display_name, :avatar_url)
returning id
