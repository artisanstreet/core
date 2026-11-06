select totp_verified
from desktop_grants
where code_hash = :code_hash
