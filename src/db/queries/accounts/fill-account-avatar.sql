update accounts
set avatar_url = :avatar_url
where id = :id and avatar_url is null
