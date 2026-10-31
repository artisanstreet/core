select a.id, a.totp_enrolled_at, a.deleted_at
from sign_in_methods m
join accounts a on a.id = m.account_id
where m.kind = :kind and m.subject = :subject
