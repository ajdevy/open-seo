import json
from pathlib import Path
import subprocess
import tempfile
import unittest

from upstream_release_sync import STATE, git, merge_release, validate_release


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
        self.write(self.fork, STATE, json.dumps({"release_commit": self.initial}) + "\n")
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
        self.commit(self.upstream, "next release")
        if annotated:
            git(self.upstream, "tag", "-a", "v1.0.1", "-m", "stable")
        else:
            git(self.upstream, "tag", "v1.0.1")
        return git(self.upstream, "rev-parse", "HEAD").stdout.strip()

    def assert_original(self):
        self.assertEqual(git(self.fork, "rev-parse", "HEAD").stdout.strip(), self.base)
        self.assertEqual(git(self.fork, "status", "--porcelain").stdout, "")

    def test_merge_keeps_local_features_and_ci_and_excludes_new_upstream_workflows(self):
        sha = self.release(annotated=True)
        self.assertTrue(merge_release(self.fork, "v1.0.1", sha, str(self.upstream)))
        self.assertEqual((self.fork / "app.txt").read_text(), "release change\n")
        self.assertEqual((self.fork / "autogeo.txt").read_text(), "our feature\n")
        self.assertEqual((self.fork / ".github/workflows/autogeo.yml").read_text(), "trusted fork CI\n")
        self.assertEqual(list((self.fork / ".github/workflows").iterdir()), [self.fork / ".github/workflows/autogeo.yml"])
        self.assertEqual(json.loads((self.fork / STATE).read_text())["release_commit"], sha)
        self.assertEqual(git(self.fork, "rev-parse", "HEAD^2").stdout.strip(), sha)
        self.assertFalse(merge_release(self.fork, "v1.0.1", sha, str(self.upstream)))

    def test_already_included_release_makes_no_commit(self):
        self.assertFalse(merge_release(self.fork, "v1.0.0", self.initial, str(self.upstream)))
        self.assert_original()

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
        with self.assertRaisesRegex(RuntimeError, "does not descend"):
            merge_release(self.fork, "v1.0.0", self.initial, str(self.upstream))

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


class ReleaseSelectionTest(unittest.TestCase):
    def test_only_published_stable_semver_release_is_accepted(self):
        release = {"tag_name": "v1.2.3", "draft": False, "prerelease": False, "published_at": "2026-10-27T00:00:00Z"}
        self.assertEqual(validate_release(release, "a" * 40), "v1.2.3")
        for override in ({"draft": True}, {"prerelease": True}, {"published_at": None}, {"tag_name": "v1.2.3-rc.1"}, {"tag_name": "--upload-pack=evil"}):
            with self.subTest(override=override), self.assertRaises(ValueError):
                validate_release({**release, **override}, "a" * 40)


if __name__ == "__main__":
    unittest.main()
