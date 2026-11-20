-- A pre-upgrade queued or running run may already have called a paid
-- provider, but has no cost reservation to reconcile. Hold the entire
-- installation cap until an operator records usage evidence or confirms zero
-- charge. Unknown reservations are intentionally excluded from the per-project
-- active-reservation index and remain charged to rolling usage until settled.
INSERT INTO "ai_provider_run_reservations" (
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
	'legacy-active-run:' || "ai_runs"."id",
	"ai_runs"."project_id",
	"ai_runs"."id",
	8000000,
	NULL,
	'unknown',
	"ai_runs"."created_at",
	NULL,
	NULL,
	NULL
FROM "ai_runs"
WHERE "ai_runs"."status" IN ('queued', 'running')
	AND NOT EXISTS (
		SELECT 1
		FROM "ai_provider_run_reservations"
		WHERE "ai_provider_run_reservations"."run_id" = "ai_runs"."id"
	);
