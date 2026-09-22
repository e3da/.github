#!/usr/bin/env bash
set -Eeuo pipefail

# Convert raw avatar sources to 64x64 JPGs, optionally as a complete Git
# transaction.
# Mode 0 prints commands, mode 1 converts locally, mode 2 pulls and commits with
# rollback/push, and mode 3 converts and validates without Git operations.

usage() {
  cat <<'EOF'
Usage: scripts/usr/bin/png2jpg.sh <mode>

Modes:
  0  Dry run: print the ImageMagick commands without changing files.
  1  Convert raw PNG and JPEG avatars locally.
  2  Pull origin/main, generate only missing JPGs, validate, commit, and push.
  3  Convert raw PNG and JPEG avatars, and validate locally.

Note: mode 2 restores the original commit and removes generated files if any
step fails. Mode 3 leaves files as-is when a step fails and never pushes.
EOF
}

if (($# == 0)); then
  usage
  exit 0
fi

if (($# != 1)) || [[ ! $1 =~ ^[0123]$ ]]; then
  printf 'Error: mode must be 0, 1, 2, or 3.\n\n' >&2
  usage >&2
  exit 2
fi

mode=$1
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
root_dir=$(cd -- "$script_dir/../../.." && pwd)
source_dir="$root_dir/profile/members/avatars/raw"
destination_dir="$root_dir/profile/members/avatars/jpg"

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

  local source filename extension destination temporary
  local found_source=false
  for source in "$source_dir"/*; do
    [[ -f "$source" ]] || continue
    found_source=true
    filename=$(basename "$source" .png)
    extension=${source##*.}
    extension=${extension,,}
    if [[ $extension != png && $extension != jpg && $extension != jpeg ]]; then
      continue
    fi
    filename=$(basename "$source")
    filename=${filename%.*}
    filename=${filename,,}
    destination="$destination_dir/$filename.jpg"
    temporary="$destination_dir/.$filename.jpg.tmp"
    if [[ -e "$destination" || -L "$destination" ]]; then
      continue
    fi
    if [[ $mode == 0 ]]; then
      printf '  %q' "${converter[@]}"
      printf ' %q' "$source" -resize '64x64^' -gravity center -extent 64x64 -background white -alpha remove -alpha off -strip -quality 90 "jpg:$temporary"
      printf '\n'
    fi
    if [[ $mode != 0 ]]; then
      "${converter[@]}" "$source" \
        -resize '64x64^' \
        -gravity center \
        -extent 64x64 \
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

if [[ $mode == 2 || $mode == 3 ]]; then
  node "$root_dir/scripts/validate-members.js"
fi

if [[ $mode == 2 ]]; then
  git -C "$root_dir" add profile/README.md profile/members/
  if git -C "$root_dir" diff --cached --quiet; then
    printf 'No avatar or profile changes to commit.\n'
    exit 0
  fi
  git -C "$root_dir" commit -m 'chore: update JPG avatars'
  git -C "$root_dir" push origin main
fi

printf 'Converted %d avatar(s).\n' "$conversion_count"
