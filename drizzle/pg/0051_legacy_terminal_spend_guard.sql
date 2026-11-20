-- A terminal run created before provider reservations may have incurred paid
-- provider spend without a ledger row. Hold the installation-wide cap for
-- one rolling window after migration, then let that untracked exposure roll
-- off. This is a bounded guard, not a provider-reported charge.
WITH recent_untracked_terminal_run AS (
	SELECT id, project_id, COALESCE(completed_at, created_at) AS latest_run_time
	FROM ai_runs
	WHERE status IN ('completed', 'partial', 'failed')
		AND (
			created_at >= to_char((now() AT TIME ZONE 'utc') - interval '7 days', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
			OR completed_at >= to_char((now() AT TIME ZONE 'utc') - interval '7 days', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
		)
		AND NOT EXISTS (
			SELECT 1
			FROM ai_provider_run_reservations
			WHERE ai_provider_run_reservations.run_id = ai_runs.id
		)
	ORDER BY COALESCE(completed_at, created_at) DESC
	LIMIT 1
)
INSERT INTO ai_provider_run_reservations (
	"id",
	"project_id",
	"run_id",
	"reserved_usd_micros",
	"accounted_usd_micros",
	"status",
	"created_at",
	"settled_at",
	"reconciliation_reference",
	"reconciled_at"
)
SELECT
	'legacy-terminal-spend-guard',
	recent_untracked_terminal_run.project_id,
	recent_untracked_terminal_run.id,
	8000000,
	NULL,
	'legacy_guard',
	to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
	NULL,
	'migration:legacy-terminal-spend-window',
	NULL
FROM recent_untracked_terminal_run;
