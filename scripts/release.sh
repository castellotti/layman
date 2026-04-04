#!/usr/bin/env bash
set -euo pipefail

# Usage: ./scripts/release.sh <version>
# Example: ./scripts/release.sh 1.2.3
#          ./scripts/release.sh v1.2.3

VERSION="${1:-}"

# Strip leading 'v' for semver validation, re-add for the tag
VERSION="${VERSION#v}"

if [[ -z "$VERSION" ]]; then
  echo "Usage: $0 <version>" >&2
  echo "Example: $0 1.2.3" >&2
  exit 1
fi

if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9._-]+)?(\+[a-zA-Z0-9._-]+)?$ ]]; then
  echo "Error: '$VERSION' is not a valid semver (expected X.Y.Z)" >&2
  exit 1
fi

TAG="v${VERSION}"

# Verify we're on main and the tree is clean
BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [[ "$BRANCH" != "main" ]]; then
  echo "Error: must release from main (currently on '$BRANCH')" >&2
  exit 1
fi

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "Error: working tree has uncommitted changes" >&2
  git status --short
  exit 1
fi

# Ensure local main is up to date with origin
echo "Fetching origin..."
git fetch origin main --quiet

LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse origin/main)
if [[ "$LOCAL" != "$REMOTE" ]]; then
  echo "Error: local main is not in sync with origin/main" >&2
  echo "  local:  $LOCAL" >&2
  echo "  remote: $REMOTE" >&2
  exit 1
fi

# Check the tag doesn't already exist
if git rev-parse "$TAG" >/dev/null 2>&1; then
  echo "Error: tag '$TAG' already exists" >&2
  exit 1
fi

echo ""
echo "  Release: $TAG"
echo "  Commit:  $(git rev-parse --short HEAD) — $(git log -1 --format='%s')"
echo "  Target:  ghcr.io/castellotti/layman:${VERSION}"
echo ""
read -r -p "Bump versions, commit, tag, and push '$TAG'? [y/N] " CONFIRM

case "$CONFIRM" in
  [yY][eE][sS]|[yY])
    ;;
  *)
    echo "Aborted."
    exit 0
    ;;
esac

# Bump version in all package.json files
REPO_ROOT="$(git rev-parse --show-toplevel)"
for PKG in \
  "$REPO_ROOT/package.json" \
  "$REPO_ROOT/packages/server/package.json" \
  "$REPO_ROOT/packages/web/package.json"; do
  if [[ -f "$PKG" ]]; then
    # Use node to do a clean JSON-preserving replacement
    node -e "
      const fs = require('fs');
      const p = JSON.parse(fs.readFileSync('$PKG', 'utf-8'));
      p.version = '$VERSION';
      fs.writeFileSync('$PKG', JSON.stringify(p, null, 2) + '\n');
    "
    echo "Bumped $PKG → $VERSION"
  fi
done

git add \
  "$REPO_ROOT/package.json" \
  "$REPO_ROOT/packages/server/package.json" \
  "$REPO_ROOT/packages/web/package.json"

git commit -m "chore: release $TAG"
echo "Committed version bump"

git push origin main
echo "Pushed version bump to main"

git tag -a "$TAG" -m "Release $TAG"
echo "Created tag $TAG"

git push origin "$TAG"
echo "Pushed tag $TAG"

echo ""
echo "GitHub Actions will now build and push:"
echo "  ghcr.io/castellotti/layman:${VERSION}"
echo "  ghcr.io/castellotti/layman:$(echo "$VERSION" | cut -d. -f1-2)"
echo "  ghcr.io/castellotti/layman:$(echo "$VERSION" | cut -d. -f1)"
echo "  ghcr.io/castellotti/layman:latest"
echo ""
echo "Track progress at: https://github.com/castellotti/layman/actions"
