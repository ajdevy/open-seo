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


def merge_release(root, tag, commit, upstream_url):
    """Apply one release locally; callers publish only after all checks pass."""
    if git(root, "status", "--porcelain").stdout:
        raise RuntimeError("Refusing to merge into a dirty checkout")
    if git(root, "branch", "--show-current").stdout.strip() != "main":
        raise RuntimeError("Release synchronization must run on main")
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
        # This checkout is clean and disposable. Abort preserves the original fork.
        git(root, "merge", "--abort", check=False)
        raise


def api(path):
    return json.loads(subprocess.check_output(["gh", "api", path], text=True))


def main():
    if os.environ.get("GITHUB_REPOSITORY") != FORK:
        raise RuntimeError("This automation may update only the configured fork")
    if os.environ.get("GITHUB_REF") != "refs/heads/main":
        raise RuntimeError("This automation may run only from main")
    root = Path(__file__).resolve().parents[2]
    release = api(f"repos/{UPSTREAM}/releases/latest")
    tag = validate_release(release, "0" * 40)
    commit = api(f"repos/{UPSTREAM}/commits/{tag}")["sha"]
    validate_release(release, commit)
    changed = merge_release(root, tag, commit, f"https://github.com/{UPSTREAM}.git")
    outcome = f"OpenSEO {tag} ({commit}): " + ("merged" if changed else "already included")
    print(outcome)
    if output := os.environ.get("GITHUB_OUTPUT"):
        with open(output, "a") as stream:
            stream.write(f"changed={str(changed).lower()}\n")
    if summary := os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(summary, "a") as stream:
            stream.write(outcome + "\n\nFork CI preserved; no application deployment.\n")


if __name__ == "__main__":
    main()
