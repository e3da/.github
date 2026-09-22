#!/usr/bin/env bash
set -Eeuo pipefail

# Convert PNG avatar sources to JPG, optionally as a complete Git transaction.
# Mode 0 prints conversion commands, mode 1 converts locally, and mode 2 pulls,
# converts, regenerates PNG-first metadata, commits, and pushes the result.

usage() {
  cat <<'EOF'
Usage: scripts/usr/bin/png2jpg.sh <mode>

Modes:
  0  Dry run: print the ImageMagick commands without changing files.
  1  Convert PNG avatars to JPG files locally.
  2  Pull origin/main, convert avatars, regenerate metadata, commit, and push.

Note: mode 2 restores the original commit and removes generated files if any
step fails. Review the dry-run output with mode 0 before using mode 1 or 2.
EOF
}

if (($# == 0)); then
  usage
  exit 0
fi

if (($# != 1)) || [[ ! $1 =~ ^[012]$ ]]; then
  printf 'Error: mode must be 0, 1, or 2.\n\n' >&2
  usage >&2
  exit 2
fi

mode=$1
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
root_dir=$(cd -- "$script_dir/../../.." && pwd)
source_dir="$root_dir/profile/members/avatars/png"
destination_dir="$root_dir/profile/members/avatars/jpg"
git_dir="$root_dir/.git"

if command -v magick >/dev/null 2>&1; then
  converter=(magick)
elif command -v convert >/dev/null 2>&1; then
  converter=(convert)
else
  printf 'Error: ImageMagick (magick or convert) is required.\n' >&2
  exit 1
fi

conversion_count=0

convert_avatars() {
  if [[ $mode != 0 ]]; then
    mkdir -p "$destination_dir"
  fi

  local source filename destination temporary
  local found_source=false
  for source in "$source_dir"/*.png; do
    [[ -f "$source" ]] || continue
    found_source=true
    filename=$(basename "$source" .png)
    destination="$destination_dir/$filename.jpg"
    temporary="$destination_dir/.$filename.jpg.tmp"
    if [[ $mode == 0 ]]; then
      printf '  %q' "${converter[@]}"
      printf ' %q' "$source" -background white -alpha remove -alpha off -strip -quality 90 "jpg:$temporary"
      printf '\n'
    fi
    if [[ $mode != 0 ]]; then
      "${converter[@]}" "$source" \
        -background white \
        -alpha remove \
        -alpha off \
        -strip \
        -quality 90 \
        "jpg:$temporary"
      mv -- "$temporary" "$destination"
      conversion_count=$((conversion_count + 1))
    fi
  done

  if [[ $found_source == false ]]; then
    printf 'Warning: no PNG files found in %s\n' "$source_dir" >&2
  fi
}

if [[ $mode == 0 ]]; then
  convert_avatars
  exit 0
fi

original_head=''
rollback() {
  local exit_code=$?
  trap - ERR
  if [[ $mode == 2 && -n $original_head ]]; then
    printf 'Error: operation failed; restoring %s\n' "$original_head" >&2
    git -C "$root_dir" reset --hard "$original_head" || true
    git -C "$root_dir" clean -fd -- profile/members/avatars/jpg || true
  fi
  exit "$exit_code"
}

if [[ $mode == 2 ]]; then
  original_head=$(git -C "$root_dir" rev-parse HEAD)
  if [[ -n $(git -C "$root_dir" status --porcelain) ]]; then
    printf 'Error: mode 2 requires a clean Git worktree.\n' >&2
    exit 1
  fi
  trap rollback ERR
  git -C "$root_dir" pull --ff-only origin main
fi

convert_avatars

if [[ $mode == 2 ]]; then
  UPDATE_AVATARS=false node "$root_dir/scripts/update-members.js"
  node "$root_dir/scripts/validate-members.js"
  git -C "$root_dir" add profile/README.md profile/members/
  if git -C "$root_dir" diff --cached --quiet; then
    printf 'No avatar or profile changes to commit.\n'
    exit 0
  fi
  git -C "$root_dir" commit -m 'chore: update JPG avatars'
  git -C "$root_dir" push origin main
fi

printf 'Converted %d avatar(s).\n' "$conversion_count"
