import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from upstream_release_sync import STATE, git, merge_release, release_branch, validate_release
from validate_candidate_pr import validate_pull_request


class ReleaseMergeTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.upstream = self.root / "upstream"
        self.fork = self.root / "fork"
        subprocess.run(["git", "init", "-q", "-b", "main", str(self.upstream)], check=True)
        self.configure(self.upstream)
        self.write(self.upstream, "app.txt", "original\n")
        self.write(self.upstream, ".github/workflows/publish.yml", "upstream publish\n")
        self.commit(self.upstream, "initial release")
        self.initial = git(self.upstream, "rev-parse", "HEAD").stdout.strip()
        git(self.upstream, "tag", "v1.0.0")
        subprocess.run(["git", "clone", "-q", str(self.upstream), str(self.fork)], check=True)
        self.configure(self.fork)
        git(self.fork, "rm", ".github/workflows/publish.yml")
        self.write(self.fork, ".github/workflows/autogeo.yml", "trusted fork CI\n")
        self.write(self.fork, "autogeo.txt", "our feature\n")
        self.write(self.fork, "scripts/autogeo/trusted.txt", "trusted maintenance\n")
        self.write(self.fork, STATE, json.dumps({"release_tag": "v1.0.0", "release_commit": self.initial}) + "\n")
        self.commit(self.fork, "fork customization")
        self.base = git(self.fork, "rev-parse", "HEAD").stdout.strip()

    def configure(self, repo):
        git(repo, "config", "user.name", "Sync test")
        git(repo, "config", "user.email", "sync@example.invalid")
        git(repo, "config", "commit.gpgsign", "false")

    def write(self, repo, path, text):
        target = repo / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text)

    def commit(self, repo, message):
        git(repo, "add", ".")
        git(repo, "commit", "-q", "-m", message)

    def release(self, app="release change\n", annotated=False):
        self.write(self.upstream, "app.txt", app)
        self.write(self.upstream, ".github/workflows/publish.yml", "changed publish\n")
        self.write(self.upstream, ".github/workflows/new-deploy.yml", "new deploy\n")
        self.write(self.upstream, "scripts/autogeo/trusted.txt", "upstream replacement\n")
        self.write(self.upstream, "scripts/autogeo/test_new.py", "raise RuntimeError('must not execute')\n")
        self.commit(self.upstream, "next release")
        if annotated:
            git(self.upstream, "tag", "-a", "v1.0.1", "-m", "stable")
        else:
            git(self.upstream, "tag", "v1.0.1")
        return git(self.upstream, "rev-parse", "HEAD").stdout.strip()

    def assert_original(self):
        self.assertEqual(git(self.fork, "branch", "--show-current").stdout.strip(), "main")
        self.assertEqual(git(self.fork, "rev-parse", "HEAD").stdout.strip(), self.base)
        self.assertEqual(git(self.fork, "status", "--porcelain").stdout, "")

    def test_merge_keeps_local_features_and_ci_and_excludes_new_upstream_workflows(self):
        sha = self.release(annotated=True)
        self.assertTrue(merge_release(self.fork, "v1.0.1", sha, str(self.upstream)))
        self.assertEqual(
            git(self.fork, "branch", "--show-current").stdout.strip(),
            release_branch("v1.0.1"),
        )
        self.assertEqual(git(self.fork, "rev-parse", "main").stdout.strip(), self.base)
        self.assertEqual((self.fork / "app.txt").read_text(), "release change\n")
        self.assertEqual((self.fork / "autogeo.txt").read_text(), "our feature\n")
        self.assertEqual((self.fork / ".github/workflows/autogeo.yml").read_text(), "trusted fork CI\n")
        self.assertEqual(list((self.fork / ".github/workflows").iterdir()), [self.fork / ".github/workflows/autogeo.yml"])
        self.assertEqual(json.loads((self.fork / STATE).read_text())["release_commit"], sha)
        self.assertEqual((self.fork / "scripts/autogeo/trusted.txt").read_text(), "trusted maintenance\n")
        self.assertFalse((self.fork / "scripts/autogeo/test_new.py").exists())
        self.assertEqual(git(self.fork, "rev-parse", "HEAD^2").stdout.strip(), sha)

    def test_already_included_release_makes_no_commit(self):
        self.assertFalse(merge_release(self.fork, "v1.0.0", self.initial, str(self.upstream)))
        self.assert_original()

    def test_release_already_merged_from_review_branch_makes_no_new_candidate(self):
        sha = self.release()
        candidate = release_branch("v1.0.1")
        self.assertTrue(merge_release(self.fork, "v1.0.1", sha, str(self.upstream), candidate))
        git(self.fork, "switch", "main")
        git(self.fork, "merge", "--no-ff", "--no-edit", candidate)
        merged_head = git(self.fork, "rev-parse", "HEAD").stdout.strip()
        self.assertFalse(merge_release(self.fork, "v1.0.1", sha, str(self.upstream), candidate))
        self.assertEqual(git(self.fork, "rev-parse", "HEAD").stdout.strip(), merged_head)

    def test_application_conflict_aborts_and_preserves_fork(self):
        self.write(self.fork, "app.txt", "local feature\n")
        self.commit(self.fork, "local application change")
        self.base = git(self.fork, "rev-parse", "HEAD").stdout.strip()
        sha = self.release()
        with self.assertRaisesRegex(RuntimeError, "conflicts require review: app.txt"):
            merge_release(self.fork, "v1.0.1", sha, str(self.upstream))
        self.assert_original()
        self.assertEqual((self.fork / "app.txt").read_text(), "local feature\n")

    def test_moved_tag_is_rejected_before_merge(self):
        self.release()
        with self.assertRaisesRegex(RuntimeError, "tag moved"):
            merge_release(self.fork, "v1.0.1", self.initial, str(self.upstream))
        self.assert_original()

    def test_release_rollback_is_rejected(self):
        sha = self.release()
        merge_release(self.fork, "v1.0.1", sha, str(self.upstream))
        git(self.fork, "switch", "main")
        git(self.fork, "merge", "--no-ff", "--no-edit", release_branch("v1.0.1"))
        with self.assertRaisesRegex(RuntimeError, "does not descend"):
            merge_release(self.fork, "v1.0.0", self.initial, str(self.upstream))

    def test_recorded_tag_cannot_move_to_a_descendant_commit(self):
        self.release()
        git(self.upstream, "tag", "-f", "v1.0.0")
        sha = git(self.upstream, "rev-parse", "HEAD").stdout.strip()
        with self.assertRaisesRegex(RuntimeError, "Recorded release tag moved"):
            merge_release(self.fork, "v1.0.0", sha, str(self.upstream))
        self.assert_original()

    def test_isolated_discovery_does_not_import_application_shadow_modules(self):
        self.write(self.fork, "json.py", "raise RuntimeError('application module executed')\n")
        self.write(self.fork, "unittest.py", "raise RuntimeError('application module executed')\n")
        self.write(self.fork, "scripts/autogeo/test_trusted.py", "import json\nimport unittest\nclass TrustedTest(unittest.TestCase):\n    def test_safe(self):\n        self.assertEqual(json.loads('1'), 1)\n")
        result = subprocess.run(
            [sys.executable, "-I", "-B", "-m", "unittest", "discover", "-s", "scripts/autogeo", "-p", "test_trusted.py"],
            cwd=self.fork, text=True, capture_output=True,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("Ran 1 test", result.stderr)

    def test_whitespace_failure_aborts_without_publishing(self):
        sha = self.release(app="trailing whitespace  \n")
        with self.assertRaisesRegex(RuntimeError, "diff failed"):
            merge_release(self.fork, "v1.0.1", sha, str(self.upstream))
        self.assert_original()

    def test_dirty_checkout_is_preserved(self):
        self.write(self.fork, "autogeo.txt", "uncommitted work\n")
        with self.assertRaisesRegex(RuntimeError, "dirty checkout"):
            merge_release(self.fork, "v1.0.0", self.initial, str(self.upstream))
        self.assertEqual((self.fork / "autogeo.txt").read_text(), "uncommitted work\n")

    def test_candidate_branch_must_match_stable_release_tag(self):
        sha = self.release()
        with self.assertRaisesRegex(RuntimeError, "does not match the stable tag"):
            merge_release(self.fork, "v1.0.1", sha, str(self.upstream), "main")
        self.assert_original()


class ReleaseSelectionTest(unittest.TestCase):
    def test_only_published_stable_semver_release_is_accepted(self):
        release = {"tag_name": "v1.2.3", "draft": False, "prerelease": False, "published_at": "2026-10-27T00:00:00Z"}
        self.assertEqual(validate_release(release, "a" * 40), "v1.2.3")
        for override in ({"draft": True}, {"prerelease": True}, {"published_at": None}, {"tag_name": "v1.2.3-rc.1"}, {"tag_name": "--upload-pack=evil"}):
            with self.subTest(override=override), self.assertRaises(ValueError):
                validate_release({**release, **override}, "a" * 40)

    def test_release_branch_uses_only_stable_semver_tags(self):
        self.assertEqual(release_branch("v1.2.3"), "autogeo/upstream/v1.2.3")
        for tag in ("v1.2.3-rc.1", "main", "v1/2/3", "--upload-pack=evil"):
            with self.subTest(tag=tag), self.assertRaises(ValueError):
                release_branch(tag)


class WorkflowReviewSafetyTest(unittest.TestCase):
    def test_workflow_publishes_only_a_review_branch(self):
        root = Path(__file__).resolve().parents[2]
        workflow = (root / ".github/workflows/autogeo-upstream-release-sync.yml").read_text()
        self.assertIn("pull-requests: write", workflow)
        self.assertIn('push origin "HEAD:refs/heads/$RELEASE_BRANCH"', workflow)
        self.assertNotIn("HEAD:refs/heads/main", workflow)
        self.assertIn("gh pr create", workflow)
        self.assertIn("--draft", workflow)
        self.assertIn("actions: write", workflow)
        self.assertIn("gh workflow run autogeo-upstream-candidate-compatibility.yml", workflow)
        self.assertIn("gh workflow run autogeo-upstream-sync-tests.yml", workflow)
        self.assertIn('--ref "$RELEASE_BRANCH"', workflow)
        self.assertIn('--field pull_request_number="$PR_NUMBER"', workflow)

    def test_policy_tests_run_on_isolated_read_only_runner(self):
        root = Path(__file__).resolve().parents[2]
        workflow = (root / ".github/workflows/autogeo-upstream-sync-tests.yml").read_text()
        self.assertIn("pull_request:", workflow)
        self.assertIn("docs/maintainers/upstream-release-deployment.md", workflow)
        self.assertIn("runs-on: ubuntu-24.04", workflow)
        self.assertNotIn("self-hosted", workflow)
        self.assertIn("permissions:\n  contents: read", workflow)
        self.assertIn("github.ref_name", workflow)
        self.assertIn("persist-credentials: false", workflow)
        self.assertIn("python3 -I -B -m unittest discover", workflow)

    def test_candidate_compatibility_uses_an_isolated_read_only_runner(self):
        root = Path(__file__).resolve().parents[2]
        workflow = (
            root
            / ".github/workflows/autogeo-upstream-candidate-compatibility.yml"
        ).read_text()
        self.assertIn("pull_request:", workflow)
        self.assertNotIn("pull_request_target", workflow)
        self.assertIn("startsWith(github.head_ref, 'autogeo/upstream/v')", workflow)
        self.assertIn("runs-on: ubuntu-24.04", workflow)
        self.assertNotIn("self-hosted", workflow)
        self.assertIn("permissions:\n  contents: read", workflow)
        self.assertIn("pull-requests: read", workflow)
        self.assertIn("persist-credentials: false", workflow)
        for action in (
            "actions/checkout@11d5960a326750d5838078e36cf38b85af677262",
            "pnpm/action-setup@b906affcce14559ad1aafd4ab0e942779e9f58b1",
            "actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020",
        ):
            with self.subTest(action=action):
                self.assertIn(action, workflow)
        for command in (
            "pnpm build",
            "pnpm test:ci",
            "pnpm test:standalone:backup",
            "pnpm test:standalone:client-restore",
            "pnpm db:migrate:local",
            "pnpm db:migrate:pg",
        ):
            with self.subTest(command=command):
                self.assertIn(command, workflow)
        self.assertIn("pnpm test:ci --maxWorkers=4", workflow)
        self.assertNotIn("pnpm deploy", workflow)
        self.assertIn("workflow_dispatch:", workflow)
        self.assertIn("pull_request_number", workflow)
        self.assertIn("validate_candidate_pr.py", workflow)
        self.assertIn("github.event_name == 'workflow_dispatch'", workflow)

    def test_dispatched_candidate_pr_is_exact_open_fork_head(self):
        sha = "a" * 40
        pull = {
            "state": "open",
            "base": {"ref": "main", "repo": {"full_name": "ajdevy/open-seo"}},
            "head": {
                "ref": "autogeo/upstream/v1.2.3",
                "sha": sha,
                "repo": {"full_name": "ajdevy/open-seo"},
            },
        }
        validate_pull_request(
            pull,
            repository="ajdevy/open-seo",
            branch="autogeo/upstream/v1.2.3",
            commit_sha=sha,
        )

        mutations = (
            {"state": "closed"},
            {"base": {"ref": "release", "repo": {"full_name": "ajdevy/open-seo"}}},
            {"head": {**pull["head"], "sha": "b" * 40}},
            {"head": {**pull["head"], "repo": {"full_name": "attacker/open-seo"}}},
        )
        for mutation in mutations:
            with self.subTest(mutation=mutation), self.assertRaises(ValueError):
                validate_pull_request(
                    {**pull, **mutation},
                    repository="ajdevy/open-seo",
                    branch="autogeo/upstream/v1.2.3",
                    commit_sha=sha,
                )

    def test_dispatched_candidate_rejects_untrusted_ref_or_repository(self):
        pull = {
            "state": "open",
            "base": {"ref": "main", "repo": {"full_name": "ajdevy/open-seo"}},
            "head": {
                "ref": "autogeo/upstream/v1.2.3",
                "sha": "a" * 40,
                "repo": {"full_name": "ajdevy/open-seo"},
            },
        }
        for repository, branch, sha in (
            ("attacker/open-seo", "autogeo/upstream/v1.2.3", "a" * 40),
            ("ajdevy/open-seo", "main", "a" * 40),
            ("ajdevy/open-seo", "autogeo/upstream/v1.2.3", "short"),
        ):
            with self.subTest(repository=repository, branch=branch), self.assertRaises(ValueError):
                validate_pull_request(
                    pull,
                    repository=repository,
                    branch=branch,
                    commit_sha=sha,
                )

    def test_policy_workflow_can_be_dispatched_for_token_created_candidate(self):
        root = Path(__file__).resolve().parents[2]
        workflow = (root / ".github/workflows/autogeo-upstream-sync-tests.yml").read_text()
        self.assertIn("workflow_dispatch:", workflow)
        self.assertIn("startsWith(github.ref, 'refs/heads/autogeo/upstream/v')", workflow)

    def test_deployment_runbook_separates_ci_backup_and_runtime_evidence(self):
        root = Path(__file__).resolve().parents[2]
        runbook = (root / "docs/maintainers/upstream-release-deployment.md").read_text()
        for required in (
            "terminal exact-SHA Reviewer `APPROVE` and QA `PASS`",
            "fresh application-consistent backup",
            "read-back",
            "isolated location",
            "rollback image digest",
            "empty\nencrypted Ductor journal",
            "zero active Codex\nprocesses",
            "`/api/health`",
            "local health test is not live runtime proof",
        ):
            with self.subTest(required=required):
                self.assertIn(required, runbook)


if __name__ == "__main__":
    unittest.main()
