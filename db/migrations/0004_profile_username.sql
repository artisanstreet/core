alter table accounts add column if not exists username text;
create unique index if not exists accounts_username_unique on accounts (username);
