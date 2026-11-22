# Upstream release deployment gate

The weekly upstream sync may create a review branch and draft pull request. It
never merges to `main` or deploys production. A passing candidate workflow is
CI evidence for that candidate SHA; it is not production backup, restore or
runtime evidence.

## Required before merging to `main`

1. Confirm the open pull request points to `main` and record its full head SHA.
2. Require successful `policy-tests` and `compatibility` checks on that exact
   SHA. The candidate workflow validates its dispatched PR number, base,
   fork-owned branch and full head SHA before running candidate code.
3. Obtain Ductor's terminal exact-SHA Reviewer `APPROVE` and QA `PASS` for the
   canonical story spec and patch. Confirm the encrypted inter-agent journal
   has no open records before starting either gate. A review of an earlier or
   later SHA does not satisfy this requirement.
4. Inspect the diff and release manifest. Keep `.github/workflows/`,
   `scripts/autogeo/`, and AutoGeo deployment/configuration paths under fork
   review; do not let the upstream merge replace the fork's release controls.

The active `AutoGeo main review gate` ruleset enforces pull requests, strict
required checks, and blocks force-push and branch deletion. It has no bypass
actors. If that ruleset is absent or inactive, do not merge.

## Required before a separate production deployment

Record and verify this evidence for the selected full commit SHA before
authorizing a production stage:

- The deployed target, current image digest, current migration version, and
  exact candidate commit SHA.
- A fresh application-consistent backup created after the candidate passes
  review. Record its immutable artifact identifier and SHA-256 manifest; verify
  the manifest by reading the artifact back.
- A restore of that backup into an isolated location, with row/object counts and
  checksums compared to the backup manifest. Keep the source backup intact.
- The rollback image digest and migration rollback procedure. Verify the
  procedure against the candidate's migration plan; do not assume a destructive
  migration can be reversed.
- A named authorization for the production stage and a written go/no-go result.

If any backup, read-back, restore, compatibility or rollback evidence is absent
or fails, do not deploy and keep the last confirmed release running. Local
SQLite/PostgreSQL migration tests and synthetic archive fixtures do not satisfy
the production backup/restore requirement.

The production stage is separate from the Ductor CI sync runner. Before
starting it, verify integration acceptance, terminal exact-SHA gates, an empty
encrypted Ductor journal, and a fresh host guard showing zero active Codex
processes. The stage must use the exact approved SHA/image digest, preserve the
previous image and backup for rollback, and must not run against a moving branch
name such as `main` or `latest`.

## Required after deployment

Read back the installed image digest and migration version. Require HTTP 200
from `/api/health` with `status: "ok"`, then run the approved product smoke
flow and verify the expected integration data. Record timestamps and sanitized
results. If health, migration state, restore evidence or the product smoke
fails, stop traffic to the candidate and roll back to the recorded image and
data backup. A local health test is not live runtime proof.
