#!/usr/bin/env bash
set -euo pipefail

usage() {
  printf 'Usage: %s [--artifact PATH]...\n' "$0" >&2
}

if [[ ! -d .git ]] && ! git rev-parse --show-toplevel >/dev/null 2>&1; then
  printf 'Run from a repository checkout.\n' >&2
  exit 2
fi

repo_root=$(git rev-parse --show-toplevel)
if [[ "$PWD" != "$repo_root" ]]; then
  printf 'Run from the repository root.\n' >&2
  exit 2
fi
if ! command -v file >/dev/null 2>&1; then
  printf 'publication-check: file-type inspector is unavailable.\n' >&2
  exit 2
fi

artifacts=()
while (($#)); do
  case "$1" in
    --artifact)
      if (($# < 2)); then usage; exit 2; fi
      artifacts+=("$2")
      shift 2
      ;;
    *)
      usage
      exit 2
      ;;
  esac
done

failures=0
categories=(credential private-key personal-path email private-endpoint)
patterns=(
  '(ghp_|github_pat_|sk-)[A-Za-z0-9_-]{10,}|AKIA[[:upper:]0-9]{16}'
  '-----BEGIN[[:space:]]+([A-Z[:space:]]+)?PRIVATE[[:space:]]+KEY-----'
  '(/home/|/Users/|/data/)[A-Za-z0-9._-]+'
  '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}'
  '[A-Za-z0-9.-]+\.(ts\.net|internal|local)([:/[:space:]]|$)'
)

check_public_name() {
  local name=$1
  local display=$2
  local index
  local grep_result

  if [[ "$name" =~ [[:cntrl:]] ]]; then
    printf 'publication-check: control character in name: %s\n' "$display" >&2
    failures=$((failures + 1))
  fi
  for index in "${!categories[@]}"; do
    grep_result=0
    LC_ALL=C grep -aEiq -- "${patterns[$index]}" <<< "$name" || grep_result=$?
    if ((grep_result == 0)); then
      printf 'publication-check: %s in name: %s\n' "${categories[$index]}" "$display" >&2
      failures=$((failures + 1))
    elif ((grep_result > 1)); then
      printf 'publication-check: name scan failed: %s\n' "$display" >&2
      failures=$((failures + 1))
    fi
  done
}

check_file() {
  local path=$1
  local display=$2
  local public_name=$3
  local category
  local grep_result
  local encoding

  check_public_name "$public_name" "$display"
  if [[ -L "$path" || ! -f "$path" || ! -r "$path" ]]; then
    printf 'publication-check: unsupported file: %s\n' "$display" >&2
    failures=$((failures + 1))
    return
  fi

  case "${path##*/}" in
    .env|.env.*|*.pem|*.p12|*.pfx|id_rsa|id_ed25519|*.sqlite|*.db)
      printf 'publication-check: private file type: %s\n' "$display" >&2
      failures=$((failures + 1))
      ;;
    *.tar.gz|*.tgz|*.tar|*.zip|*.gz|*.xz|*.zst|*.7z)
      printf 'publication-check: archive requires extracted-tree review: %s\n' "$display" >&2
      failures=$((failures + 1))
      return
      ;;
  esac
  if ! encoding=$(LC_ALL=C file -b --mime-encoding -- "$path" 2>/dev/null); then
    printf 'publication-check: file-type inspection failed: %s\n' "$display" >&2
    failures=$((failures + 1))
    return
  fi
  case "$encoding" in
    us-ascii|utf-8) ;;
    *)
      printf 'publication-check: opaque binary requires separate review: %s\n' "$display" >&2
      failures=$((failures + 1))
      return
      ;;
  esac

  # Keep matching bytes out of CI logs. These patterns detect common mistakes,
  # not every possible secret or deployment-specific identifier.
  local index
  for index in "${!categories[@]}"; do
    grep_result=0
    LC_ALL=C grep -aEiq -- "${patterns[$index]}" "$path" || grep_result=$?
    if ((grep_result == 0)); then
      category=${categories[$index]}
      printf 'publication-check: %s: %s\n' "$category" "$display" >&2
      failures=$((failures + 1))
    elif ((grep_result > 1)); then
      printf 'publication-check: scan failed: %s\n' "$display" >&2
      failures=$((failures + 1))
    fi
  done
}

artifact_index=0
listing=$(mktemp)
trap 'rm -f "$listing"' EXIT
if git ls-files --cached --others --exclude-standard -z > "$listing" 2>/dev/null; then
  source_index=0
  while IFS= read -r -d '' path; do
    source_index=$((source_index + 1))
    check_file "$path" "source file $source_index" "$path"
  done < "$listing"
else
  printf 'publication-check: source inventory failed.\n' >&2
  failures=$((failures + 1))
fi

for artifact in "${artifacts[@]}"; do
  artifact_index=$((artifact_index + 1))
  artifact_label="artifact[$artifact_index]"
  check_public_name "${artifact##*/}" "$artifact_label"
  if [[ -L "$artifact" || ! -e "$artifact" ]]; then
    printf 'publication-check: missing or linked artifact: %s\n' "$artifact_label" >&2
    failures=$((failures + 1))
  elif [[ -d "$artifact" ]]; then
    if find "$artifact" -mindepth 1 -print0 > "$listing" 2>/dev/null; then
      file_index=0
      while IFS= read -r -d '' path; do
        file_index=$((file_index + 1))
        if [[ -d "$path" && ! -L "$path" ]]; then
          check_public_name "${path#"$artifact"/}" "$artifact_label file $file_index"
        else
          check_file "$path" "$artifact_label file $file_index" "${path#"$artifact"/}"
        fi
      done < "$listing"
    else
      printf 'publication-check: artifact traversal failed: %s\n' "$artifact_label" >&2
      failures=$((failures + 1))
    fi
  else
    check_file "$artifact" "$artifact_label" "${artifact##*/}"
  fi
done

if ((failures)); then
  printf 'publication-check: %d finding(s); inspect privately before publishing.\n' "$failures" >&2
  exit 1
fi
printf 'publication-check: no selected patterns found; human review still required.\n'
