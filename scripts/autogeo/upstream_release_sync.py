#!/usr/bin/env python3
"""Merge the latest stable OpenSEO release without replacing fork-owned CI."""

import json
import os
from pathlib import Path
import re
import subprocess

UPSTREAM = "every-app/open-seo"
FORK = "ajdevy/open-seo"
STATE = "docs/maintainers/autogeo-upstream.json"
FORK_OWNED = (".github/workflows", "scripts/autogeo")
RELEASE_BRANCH_PREFIX = "autogeo/upstream"


def git(root, *args, check=True):
    result = subprocess.run(
        ["git", "-C", str(root), *args], text=True, capture_output=True
    )
    if check and result.returncode:
        raise RuntimeError(f"git {args[0]} failed: {result.stderr.strip()}")
    return result


def validate_release(release, commit):
    tag = release.get("tag_name", "")
    if release.get("draft") is not False or release.get("prerelease") is not False:
        raise ValueError("Only published stable releases are eligible")
    if not release.get("published_at") or not re.fullmatch(r"v\d+\.\d+\.\d+", tag):
        raise ValueError("Expected a published vMAJOR.MINOR.PATCH release")
    if not re.fullmatch(r"[0-9a-f]{40}", commit):
        raise ValueError("Expected an exact upstream commit SHA")
    return tag


def release_branch(tag):
    if not re.fullmatch(r"v\d+\.\d+\.\d+", tag):
        raise ValueError("Expected a stable semantic-version release tag")
    return f"{RELEASE_BRANCH_PREFIX}/{tag}"


def merge_release(root, tag, commit, upstream_url, candidate_branch=None):
    """Prepare one release on a review branch; never advance fork main."""
    if git(root, "status", "--porcelain").stdout:
        raise RuntimeError("Refusing to merge into a dirty checkout")
    if git(root, "branch", "--show-current").stdout.strip() != "main":
        raise RuntimeError("Release synchronization must run on main")
    candidate_branch = candidate_branch or release_branch(tag)
    if candidate_branch != release_branch(tag):
        raise RuntimeError("Release candidate branch does not match the stable tag")
    base = git(root, "rev-parse", "HEAD").stdout.strip()
    git(root, "fetch", "--no-tags", upstream_url, f"refs/tags/{tag}")
    resolved = git(root, "rev-parse", "FETCH_HEAD^{commit}").stdout.strip()
    if resolved != commit:
        raise RuntimeError("Release tag moved or does not match the API commit")
    state_file = Path(root) / STATE
    if state_file.exists():
        state = json.loads(state_file.read_text())
        previous = state["release_commit"]
        if state["release_tag"] == tag and previous != commit:
            raise RuntimeError("Recorded release tag moved to a different commit")
        if git(root, "merge-base", "--is-ancestor", previous, commit, check=False).returncode:
            raise RuntimeError("Latest release does not descend from the recorded release")
    if git(root, "merge-base", "--is-ancestor", commit, base, check=False).returncode == 0:
        return False

    git(root, "switch", "--create", candidate_branch)
    try:
        merge = git(root, "merge", "--no-ff", "--no-commit", commit, check=False)
        conflicts = git(root, "diff", "--name-only", "--diff-filter=U").stdout.splitlines()
        code_conflicts = [
            p for p in conflicts
            if not any(p == owned or p.startswith(owned + "/") for owned in FORK_OWNED)
        ]
        if code_conflicts:
            raise RuntimeError("Release conflicts require review: " + ", ".join(code_conflicts))
        if merge.returncode and not conflicts:
            raise RuntimeError("Merge failed: " + merge.stderr.strip())

        # Keep every file executed by maintenance under fork control, including
        # test discovery. Fetched application code is never executed by this job.
        for owned in FORK_OWNED:
            git(root, "rm", "-r", "-f", "--ignore-unmatch", "--", owned)
            git(root, "restore", f"--source={base}", "--staged", "--worktree", "--", owned)
            if git(root, "diff", "--cached", "--name-only", "--", owned).stdout:
                raise RuntimeError("Fork-owned maintenance files changed during synchronization")

        state_file.parent.mkdir(parents=True, exist_ok=True)
        state_file.write_text(json.dumps({
            "upstream_repository": UPSTREAM,
            "release_tag": tag,
            "release_commit": commit,
        }, indent=2) + "\n")
        git(root, "add", "--", STATE)
        git(root, "diff", "--cached", "--check")
        git(root, "-c", "core.hooksPath=/dev/null", "commit", "-m", f"chore: merge OpenSEO {tag}")
        if git(root, "merge-base", "--is-ancestor", commit, "HEAD", check=False).returncode:
            raise RuntimeError("Merged commit does not include the selected release")
        return True
    except Exception:
        # The runner checkout is disposable; restore it to trusted fork main.
        git(root, "merge", "--abort", check=False)
        git(root, "switch", "main", check=False)
        git(root, "branch", "-D", candidate_branch, check=False)
        raise


def api(path):
    return json.loads(subprocess.check_output(["gh", "api", path], text=True))


def open_release_candidate_prs():
    pulls = api(f"repos/{FORK}/pulls?state=open&base=main&per_page=100")
    return [
        pull
        for pull in pulls
        if pull.get("head", {}).get("repo", {}).get("full_name") == FORK
        and pull.get("head", {}).get("ref", "").startswith(
            RELEASE_BRANCH_PREFIX + "/"
        )
    ]


def release_branch_exists(branch):
    refs = api(f"repos/{FORK}/git/matching-refs/heads/{RELEASE_BRANCH_PREFIX}/")
    expected = f"refs/heads/{branch}"
    return any(ref.get("ref") == expected for ref in refs)


def write_outputs(changed, *, tag="", branch="", pending_pr=""):
    if output := os.environ.get("GITHUB_OUTPUT"):
        with open(output, "a") as stream:
            stream.write(f"changed={str(changed).lower()}\n")
            if tag:
                stream.write(f"tag={tag}\n")
            if branch:
                stream.write(f"branch={branch}\n")
            if pending_pr:
                stream.write(f"pending_pr={pending_pr}\n")


def main():
    if os.environ.get("GITHUB_REPOSITORY") != FORK:
        raise RuntimeError("This automation may update only the configured fork")
    if os.environ.get("GITHUB_REF") != "refs/heads/main":
        raise RuntimeError("This automation may run only from main")
    root = Path(__file__).resolve().parents[2]

    pending = open_release_candidate_prs()
    if pending:
        if len(pending) != 1:
            raise RuntimeError("Multiple OpenSEO upstream release PRs need review")
        pull = pending[0]
        outcome = (
            f"OpenSEO upstream release PR #{pull['number']} is waiting for review: "
            f"{pull['html_url']}. No new candidate was created."
        )
        print(outcome)
        write_outputs(False, pending_pr=pull["html_url"])
        if summary := os.environ.get("GITHUB_STEP_SUMMARY"):
            with open(summary, "a") as stream:
                stream.write(outcome + "\n\nNothing was pushed to main or deployed.\n")
        return

    release = api(f"repos/{UPSTREAM}/releases/latest")
    tag = validate_release(release, "0" * 40)
    commit = api(f"repos/{UPSTREAM}/commits/{tag}")["sha"]
    validate_release(release, commit)
    if git(root, "merge-base", "--is-ancestor", commit, "HEAD", check=False).returncode == 0:
        outcome = f"OpenSEO {tag} ({commit}): already included"
        print(outcome)
        write_outputs(False)
        if summary := os.environ.get("GITHUB_STEP_SUMMARY"):
            with open(summary, "a") as stream:
                stream.write(outcome + "\n\nNothing was pushed or deployed.\n")
        return
    branch = release_branch(tag)
    if release_branch_exists(branch):
        raise RuntimeError(
            f"Release candidate branch {branch} exists without an open review PR; "
            "inspect it before retrying"
        )
    changed = merge_release(
        root,
        tag,
        commit,
        f"https://github.com/{UPSTREAM}.git",
        branch,
    )
    outcome = f"OpenSEO {tag} ({commit}): " + (
        f"prepared review branch {branch}" if changed else "already included"
    )
    print(outcome)
    write_outputs(changed, tag=tag if changed else "", branch=branch if changed else "")
    if summary := os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(summary, "a") as stream:
            stream.write(
                outcome
                + "\n\nThe workflow prepares a draft PR. It does not merge to main, "
                "run production migrations, or deploy the application.\n"
            )


if __name__ == "__main__":
    main()
