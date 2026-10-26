-- Append one activity event (detail is caller-supplied JSON, never secrets).
insert into activity_events (id, account_id, machine_id, kind, detail, ip)
values (:id, :accountId, :machineId, :kind, :detail::jsonb, :ip)
returning id, created_at
