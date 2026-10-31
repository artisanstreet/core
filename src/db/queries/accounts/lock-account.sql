select id, email
from accounts
where id = :id
for update
