with input as (select :now::timestamptz as now)
update desktop_grants g
set redeemed_at = (select now from input)
where g.code_hash = :code_hash
  and g.challenge = :challenge
  and g.redeemed_at is null
  and g.expires_at > (select now from input)
  and exists (
    select 1 from accounts a
    where a.id = g.account_id and a.deleted_at is null and a.disabled_at is null
  )
returning g.account_id, g.totp_verified
