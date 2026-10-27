-- Record an enrolled Forge machine (account scope from the confirmed enrollment).
insert into machines (id, account_id, public_key_x, label)
values (:id, :account_id, :public_key_x, :label)
returning id, account_id, public_key_x, label, created_at
