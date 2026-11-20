-- A terminal run created before provider reservations may have incurred paid
-- provider spend without a ledger row. Hold the installation-wide cap for
-- one rolling window after migration, then let that untracked exposure roll
-- off. This is a bounded guard, not a provider-reported charge.
INSERT INTO ai_provider_run_reservations (
	id,
	project_id,
	run_id,
	reserved_usd_micros,
	accounted_usd_micros,
	status,
	created_at,
	settled_at,
	reconciliation_reference,
	reconciled_at
)
SELECT
	'legacy-terminal-spend-guard',
	legacy_run.project_id,
	legacy_run.id,
	8000000,
	NULL,
	'legacy_guard',
	strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
	NULL,
	'migration:legacy-terminal-spend-window',
	NULL
FROM ai_runs AS legacy_run
WHERE legacy_run.status IN ('completed', 'partial', 'failed')
	AND (
		legacy_run.created_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-7 days')
		OR legacy_run.completed_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-7 days')
	)
	AND NOT EXISTS (
		SELECT 1
		FROM ai_provider_run_reservations
		WHERE ai_provider_run_reservations.run_id = legacy_run.id
	)
ORDER BY COALESCE(legacy_run.completed_at, legacy_run.created_at) DESC
LIMIT 1;
