-- Convert legacy `timelines` rows into the session model before dropping the table.
--
-- One `timeline_sessions` row per session, holding the union of every timeline's
-- events, deduped by event id or content hash and ordered by timestamp. Legacy
-- events had no `source`, so they're stamped "browser".
INSERT INTO "timeline_sessions" ("project_id", "session_id", "pending_events", "events", "updated_at", "created_at")
SELECT
	deduped.project_id,
	deduped.session_id,
	'[]'::jsonb,
	coalesce(
		jsonb_agg(deduped.element ORDER BY (deduped.element->>'timestamp')::double precision),
		'[]'::jsonb
	),
	max(deduped.received_at),
	min(deduped.received_at)
FROM (
	SELECT DISTINCT ON (t.project_id, t.session_id, event_key)
		t.project_id,
		t.session_id,
		t.received_at,
		(elem || '{"source":"browser"}'::jsonb) AS element
	FROM "timelines" t
	CROSS JOIN LATERAL jsonb_array_elements(t.events) AS e(elem)
	CROSS JOIN LATERAL (
		SELECT coalesce(
			elem->>'id',
			md5(concat_ws('|', elem->>'timestamp', elem->>'type', elem->>'name', coalesce(elem->'data', 'null'::jsonb)::text))
		) AS event_key
	) k
	ORDER BY t.project_id, t.session_id, event_key, (elem->>'timestamp')::double precision
) deduped
GROUP BY deduped.project_id, deduped.session_id;
--> statement-breakpoint
-- One `captures` marker per legacy timeline.
INSERT INTO "captures" ("project_id", "session_id", "reason_type", "reason", "meta", "tags", "occurred_at", "received_at")
SELECT
	project_id,
	session_id,
	reason_type,
	reason,
	meta,
	coalesce(tags, '{}'::text[]),
	coalesce((to_timestamp((meta->>'capturedAt')::double precision / 1000) AT TIME ZONE 'UTC'), received_at),
	received_at
FROM "timelines";
--> statement-breakpoint
DROP TABLE "timelines" CASCADE;
