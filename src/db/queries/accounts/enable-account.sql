update accounts set disabled_at = null where id = :id and deleted_at is null returning id
