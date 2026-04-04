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
read -r -p "Create and push tag '$TAG'? [y/N] " CONFIRM

case "$CONFIRM" in
  [yY][eE][sS]|[yY])
    ;;
  *)
    echo "Aborted."
    exit 0
    ;;
esac

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
