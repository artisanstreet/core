update accounts set avatar_url = :avatar_url where id = :id and deleted_at is null returning id
