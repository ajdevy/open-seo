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
standard library. The sync job does not
execute fetched application scripts, install dependencies, run provider requests,
publish images, migrate databases, or deploy the app. A successful sync proves
Git integration; application tests and deployment acceptance remain separate.

The job uses the repository-scoped `GITHUB_TOKEN` with Contents and Pull Requests
write permissions so it can publish a candidate branch and open a draft PR. No
personal GitHub token or provider credentials are installed in the fork.
Checkout does not persist the token; push receives credentials from `gh` in
memory. The candidate branch does not trigger a production deployment.
The source release is recorded in `autogeo-upstream.json`.

The job runs on the Ductor CI fleet with label `open-seo-sync`. Its runner accepts
only this workflow from this repository's `main` on schedule or manual dispatch.
It has no Docker socket or production mounts. Other application CI should use
separately reviewed execution capacity rather than this maintenance-only runner.

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
