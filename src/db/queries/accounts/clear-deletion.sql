update accounts set deletion_requested_at = null where id = :id returning id
