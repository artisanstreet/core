-- Insert a new account; email is the verified login identity.
insert into accounts (id, email, display_name)
values (:id, :email, :displayName)
returning id, email, display_name, created_at
