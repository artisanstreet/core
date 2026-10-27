-- Store a provider API-key credential (secret encrypted by the service).
-- API keys only: Core performs no OAuth for providers.
insert into provider_connections (id, account_id, provider, label, secret_enc)
values (:id, :account_id, :provider, :label, :secret_enc)
returning id, provider, label, created_at
