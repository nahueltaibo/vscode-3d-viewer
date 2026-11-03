## Releases

Every PR that changes `src/` or `media/` is a release. Bump the patch version in `package.json` and `package-lock.json` (`npm version patch --no-git-tag-version`), add a `CHANGELOG.md` entry, and title the PR `Release <version>: <summary>`. README-only PRs skip the bump.
