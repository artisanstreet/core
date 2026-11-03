update accounts set username = :username where id = :id and deleted_at is null returning id
