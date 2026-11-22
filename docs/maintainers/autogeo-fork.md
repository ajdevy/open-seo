# AutoGEO fork maintenance

This fork starts from OpenSEO v0.1.19. Retain the upstream MIT license and notice.
Application adoption is incremental; this setup does not migrate production or client data.

## Release updates

`autogeo-upstream-release-sync.yml` runs every Monday at 04:17 UTC (07:17 Moscow)
and can be dispatched manually from `main`. Upstream publishes stable GitHub
Releases with `vMAJOR.MINOR.PATCH` tags, rather than separate release branches.
The job resolves the latest published stable release to a full commit, fetches
that tag, checks the identity and prepares a merge branch named
`autogeo/upstream/<tag>`.

The job opens one draft pull request for review and never advances or deploys
`main`. An existing upstream candidate PR pauses new candidate creation until it
is reviewed. Updates use an ordinary merge, never force-push, rebase, or replace
fork history. No change is made if the release is already included. Conflicts
outside fork-owned maintenance paths, a moved tag, a non-descendant release,
whitespace errors, or an orphan candidate branch fail the job visibly without
publishing to `main`. Resolve conflicts on a reviewed branch and dispatch again.

`.github/workflows/` and `scripts/autogeo/` belong to this fork: upstream deployment, preview, image
publication and release workflows are excluded from automated merges. Review
upstream CI changes separately when changing our CI. The maintenance scripts and
tests run with isolated Python imports, so application files cannot shadow the
standard library. The sync job does not execute fetched application scripts,
install dependencies, run provider requests, publish images, migrate databases,
or deploy the app. A successful sync proves Git integration; candidate
compatibility checks and deployment acceptance remain separate.

The job uses the repository-scoped `GITHUB_TOKEN` with Contents, Pull Requests,
and Actions write permissions so it can publish a candidate branch, open a
draft PR, and dispatch the two read-only candidate checks. No personal GitHub
token or provider credentials are installed in the fork. Checkout does not
persist the token; push receives credentials from `gh` in memory.

A pull request opened by `GITHUB_TOKEN` does not start ordinary `pull_request`
workflows automatically, so the sync job dispatches policy tests and candidate
compatibility on the exact release branch. Before checking out candidate code,
the compatibility workflow verifies that its PR number, branch, repository,
base, and full head SHA still match the open fork-owned PR. The candidate
branch does not trigger a production deployment. The source release is
recorded in `autogeo-upstream.json`.

Candidate pull requests run the compatibility workflow on an ephemeral
GitHub-hosted runner with read-only repository permissions and no provider or
deployment secrets. It builds the candidate, runs the application and restore
test suite, and applies the checked-in SQLite and PostgreSQL migrations to
local test databases. The Ductor sync runner never executes the candidate
application or its dependency scripts.

The sync job runs on the Ductor CI fleet with label `open-seo-sync`. Its runner
accepts only this workflow from this repository's `main` on schedule or manual
dispatch. It has no Docker socket or production mounts. A passing candidate CI
does not establish production deployment or runtime acceptance.

The default branch must have the `AutoGeo main review gate` repository ruleset
active. It requires pull requests, strict passing `policy-tests` and
`compatibility` checks, and blocks branch deletion and non-fast-forward updates;
it has no bypass actors. Ductor's exact-SHA Reviewer and QA gates remain
separate prerequisites and are not replaced by GitHub Actions. The
predeployment backup, restore, rollback and postdeployment health evidence are
specified in [the deployment gate](upstream-release-deployment.md).

## AutoGEO execution policy

For OpenAI/ChatGPT generation, use authenticated local Codex CLI and the user's
subscription when the exact requested model is available there. Do not spend
OpenRouter balance for that model while that route is available. Do not silently
change models/providers or copy subscription credentials to another host.
Use Keynv for provider credentials, preserve already approved question wording,
and retain exact model, collection route, answer and citation provenance.
Client workspaces, prompts, answers and credentials do not belong in this public
source repository. Existing AutoGEO client-data boundaries apply until a versioned
integration contract replaces them.
