#!/usr/bin/env bash
set -euo pipefail

tmp=$(mktemp -d)
trap 'chmod -R u+rwx "$tmp" 2>/dev/null || true; rm -rf "$tmp"' EXIT
scanner="$PWD/scripts/check-publication.sh"

assert_rejected() {
  local artifact=$1
  local expected=$2
  local forbidden=${3:-}
  if bash "$scanner" --artifact "$artifact" > "$tmp/result" 2>&1; then
    printf 'Unsafe artifact was accepted.\n' >&2
    exit 1
  fi
  if ! grep -Fq -- "$expected" "$tmp/result"; then
    printf 'Expected rejection category was absent.\n' >&2
    exit 1
  fi
  if [[ -n "$forbidden" ]] && grep -Fq -- "$forbidden" "$tmp/result"; then
    printf 'Matching content or name appeared in the diagnostic.\n' >&2
    exit 1
  fi
}

printf 'portable data\n' > "$tmp/safe.txt"
if ! bash "$scanner" --artifact "$tmp/safe.txt" > "$tmp/result" 2>&1; then
  printf 'Safe artifact was rejected.\n' >&2
  exit 1
fi

categories=(credential private-key personal-path email private-endpoint)
fixtures=(
  "$(printf 'ghp_%s' 'ABCDEFGHIJKLMNOPQRST')"
  "$(printf '%s%s' '-----BEGIN ' 'PRIVATE KEY-----')"
  "$(printf '/%s/%s' home reviewer)"
  "$(printf '%s@%s' review example.invalid)"
  "$(printf '%s.%s' workspace ts.net)"
)
for index in "${!categories[@]}"; do
  printf '%s\n' "${fixtures[$index]}" > "$tmp/reject.txt"
  assert_rejected "$tmp/reject.txt" "publication-check: ${categories[$index]}: artifact[1]" "${fixtures[$index]}"
done

printf 'portable data\n' > "$tmp/.env"
assert_rejected "$tmp/.env" "publication-check: private file type: artifact[1]"

private_name="$(printf '%s@%s' review example.invalid)"
printf 'portable data\n' > "$tmp/$private_name"
assert_rejected "$tmp/$private_name" "publication-check: email in name: artifact[1]" "$private_name"
mkdir "$tmp/tree"
mkdir "$tmp/tree/$private_name"
assert_rejected "$tmp/tree" "publication-check: email in name: artifact[1] file" "$private_name"

control_name=$'bad\nname'
printf 'portable data\n' > "$tmp/$control_name"
assert_rejected "$tmp/$control_name" "publication-check: control character in name: artifact[1]"

printf '%s@%s\n' review example.invalid > "$tmp/reject.txt"
tar -czf "$tmp/release.tgz" -C "$tmp" reject.txt
assert_rejected "$tmp/release.tgz" "publication-check: archive requires extracted-tree review: artifact[1]"
cp "$tmp/release.tgz" "$tmp/release.ZIP"
assert_rejected "$tmp/release.ZIP" "publication-check: opaque binary requires separate review: artifact[1]"
cp "$tmp/release.tgz" "$tmp/release.bundle"
assert_rejected "$tmp/release.bundle" "publication-check: opaque binary requires separate review: artifact[1]"

mkdir "$tmp/repo"
git -C "$tmp/repo" init -q
printf 'portable data\n' > "$tmp/repo/safe.txt"
git -C "$tmp/repo" add -- safe.txt
if ! (cd "$tmp/repo" && bash "$scanner") > "$tmp/result" 2>&1; then
  printf 'Safe tracked source was rejected.\n' >&2
  exit 1
fi
printf '%s@%s\n' review example.invalid > "$tmp/repo/reject.txt"
git -C "$tmp/repo" add -- reject.txt
if (cd "$tmp/repo" && bash "$scanner") > "$tmp/result" 2>&1; then
  printf 'Unsafe tracked source was accepted.\n' >&2
  exit 1
fi
if ! grep -Fq 'publication-check: email: source file' "$tmp/result"; then
  printf 'Tracked source rejection was absent.\n' >&2
  exit 1
fi
printf 'portable data\n' > "$tmp/repo/$private_name"
git -C "$tmp/repo" add -- "$private_name"
if (cd "$tmp/repo" && bash "$scanner") > "$tmp/result" 2>&1; then
  printf 'Unsafe tracked source name was accepted.\n' >&2
  exit 1
fi
if ! grep -Fq 'publication-check: email in name: source file' "$tmp/result"; then
  printf 'Tracked source name rejection was absent.\n' >&2
  exit 1
fi
if grep -Fq -- "$private_name" "$tmp/result"; then
  printf 'Tracked source name appeared in the diagnostic.\n' >&2
  exit 1
fi

mkdir "$tmp/unreadable"
chmod 000 "$tmp/unreadable"
if bash "$scanner" --artifact "$tmp/unreadable" > "$tmp/result" 2>&1; then
  printf 'Unreadable artifact directory was accepted.\n' >&2
  exit 1
fi
if grep -q 'no selected patterns found' "$tmp/result"; then
  printf 'Unreadable artifact reported scan success.\n' >&2
  exit 1
fi

printf 'publication-check tests passed.\n'
