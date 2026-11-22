#!/usr/bin/env python3
"""Fail closed unless a workflow dispatch targets its matching release PR."""

import json
import os
import re
import sys
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

REPOSITORY = "ajdevy/open-seo"
RELEASE_BRANCH = re.compile(r"autogeo/upstream/v\d+\.\d+\.\d+\Z")
FULL_SHA = re.compile(r"[0-9a-f]{40}\Z")


def validate_pull_request(
    pull: dict[str, object], *, repository: str, branch: str, commit_sha: str
) -> None:
    if repository != REPOSITORY or not RELEASE_BRANCH.fullmatch(branch):
        raise ValueError("Dispatch is restricted to this fork's stable release branch")
    if not FULL_SHA.fullmatch(commit_sha):
        raise ValueError("Dispatch must identify an exact candidate commit")

    base = pull.get("base")
    head = pull.get("head")
    if not isinstance(base, dict) or not isinstance(head, dict):
        raise ValueError("Pull request base and head metadata are required")
    base_repo = base.get("repo")
    head_repo = head.get("repo")
    if (
        pull.get("state") != "open"
        or base.get("ref") != "main"
        or not isinstance(base_repo, dict)
        or base_repo.get("full_name") != REPOSITORY
        or head.get("ref") != branch
        or head.get("sha") != commit_sha
        or not isinstance(head_repo, dict)
        or head_repo.get("full_name") != REPOSITORY
    ):
        raise ValueError("Dispatch does not match an open fork-owned candidate PR")


def fetch_pull_request(repository: str, number: str, token: str) -> dict[str, object]:
    if repository != REPOSITORY or not number.isdecimal():
        raise ValueError("A numeric PR in the configured fork is required")
    request = Request(
        f"https://api.github.com/repos/{REPOSITORY}/pulls/{number}",
        headers={
            "Accept": "application/vnd.github+json",
            "Authorization": f"Bearer {token}",
            "X-GitHub-Api-Version": "2022-11-28",
        },
    )
    try:
        with urlopen(request, timeout=10) as response:
            value = json.loads(response.read())
    except (HTTPError, URLError, TimeoutError) as error:
        raise RuntimeError("Could not verify dispatched candidate PR metadata") from error
    if not isinstance(value, dict):
        raise ValueError("GitHub returned an invalid pull request response")
    return value


def main() -> None:
    token = os.environ.get("GH_TOKEN", "")
    if not token:
        raise RuntimeError("A read-only GitHub token is required")
    pull = fetch_pull_request(
        os.environ.get("REPOSITORY", ""),
        os.environ.get("PR_NUMBER", ""),
        token,
    )
    validate_pull_request(
        pull,
        repository=os.environ.get("REPOSITORY", ""),
        branch=os.environ.get("CANDIDATE_BRANCH", ""),
        commit_sha=os.environ.get("CANDIDATE_SHA", ""),
    )
    print("Verified dispatched open candidate PR and exact head SHA.")


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, ValueError) as error:
        print(f"candidate validation failed: {error}", file=sys.stderr)
        sys.exit(1)
