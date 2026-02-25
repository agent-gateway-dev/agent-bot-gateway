#!/usr/bin/env bash
set -euo pipefail

# Scan tracked files only to avoid noisy local artifacts.
files="$(git ls-files)"
if [ -z "$files" ]; then
  echo "No tracked files to scan."
  exit 0
fi

pattern='(BEGIN RSA PRIVATE KEY|BEGIN PRIVATE KEY|-----BEGIN [A-Z ]*PRIVATE KEY-----|AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,}|ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{20,}|AIza[0-9A-Za-z\-_]{35}|sk-[A-Za-z0-9]{20,})'

if git grep -n -I -E "$pattern" -- $files; then
  echo
  echo "Potential secrets found. Review matches above."
  exit 1
fi

echo "No known secret patterns found in tracked files."
