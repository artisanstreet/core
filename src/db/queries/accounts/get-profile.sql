select display_name, username, avatar_url, phone from accounts where id = :id and deleted_at is null
