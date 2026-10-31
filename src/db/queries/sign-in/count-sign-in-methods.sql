select count(*)::int as n
from sign_in_methods
where account_id = :account_id
