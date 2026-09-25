#!/usr/bin/env bash
set -euo pipefail

tmp=$(mktemp -d)
trap 'chmod -R u+rwx "$tmp" 2>/dev/null || true; rm -rf "$tmp"' EXIT

printf 'portable data\n' > "$tmp/safe.txt"
if ! bash scripts/check-publication.sh --artifact "$tmp/safe.txt" > "$tmp/result" 2>&1; then
  printf 'Safe artifact was rejected.\n' >&2
  exit 1
fi

printf '%s@%s\n' review example.invalid > "$tmp/reject.txt"
if bash scripts/check-publication.sh --artifact "$tmp/reject.txt" > "$tmp/result" 2>&1; then
  printf 'Identity fixture was accepted.\n' >&2
  exit 1
fi
if grep -q 'review@' "$tmp/result"; then
  printf 'Matching content appeared in the diagnostic.\n' >&2
  exit 1
fi

mkdir "$tmp/unreadable"
chmod 000 "$tmp/unreadable"
if bash scripts/check-publication.sh --artifact "$tmp/unreadable" > "$tmp/result" 2>&1; then
  printf 'Unreadable artifact directory was accepted.\n' >&2
  exit 1
fi
if grep -q 'no selected patterns found' "$tmp/result"; then
  printf 'Unreadable artifact reported scan success.\n' >&2
  exit 1
fi

printf 'publication-check tests passed.\n'
