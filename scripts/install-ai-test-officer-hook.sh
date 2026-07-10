#!/usr/bin/env sh
set -eu

if [ ! -d ".git" ]; then
  echo "No .git directory found. Run this from a Git worktree root." >&2
  exit 1
fi

mkdir -p .git/hooks
cp scripts/pre-commit-ai-test-officer.sh .git/hooks/pre-commit
chmod +x .git/hooks/pre-commit
echo "Installed AI Test Officer pre-commit hook at .git/hooks/pre-commit"
