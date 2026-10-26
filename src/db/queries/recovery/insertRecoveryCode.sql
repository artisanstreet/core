-- Store one recovery code hash (single use).
insert into recovery_codes (id, account_id, code_hash)
values (:id, :accountId, :codeHash)
returning id
