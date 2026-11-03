update accounts set phone = :phone where id = :id and deleted_at is null returning id
