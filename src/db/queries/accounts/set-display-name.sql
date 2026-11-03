update accounts set display_name = :display_name where id = :id and deleted_at is null returning id
