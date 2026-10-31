delete from sign_in_methods
where account_id = :account_id and kind = :kind
returning kind
