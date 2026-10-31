select kind, created_at
from sign_in_methods
where account_id = :account_id
order by created_at
