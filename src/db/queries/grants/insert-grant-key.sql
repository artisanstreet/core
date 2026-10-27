-- Register a grant signing key (private seed encrypted by the service).
insert into grant_keys (kid, public_x, private_seed_enc)
values (:kid, :public_x, :private_seed_enc)
returning kid, public_x, created_at
