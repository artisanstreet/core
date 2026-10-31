insert into sign_in_methods (account_id, kind, subject)
values (:account_id, :kind, :subject)
on conflict do nothing
returning kind
