#!/usr/bin/env bash
set -Eeuo pipefail

# Convert every committed PNG source to a same-name JPG. The script deliberately
# does not run Git commands; generation, validation, commit, and push stay separate.
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
root_dir=$(cd -- "$script_dir/../.." && pwd)
source_dir="$root_dir/profile/members/avatars/png"
destination_dir="$root_dir/profile/members/avatars/jpg"

if command -v magick >/dev/null 2>&1; then
  converter=(magick)
elif command -v convert >/dev/null 2>&1; then
  converter=(convert)
else
  printf 'Error: ImageMagick (magick or convert) is required.\n' >&2
  exit 1
fi

mkdir -p "$destination_dir"
converted=0

# Write to a temporary JPG and rename it so an interrupted conversion cannot
# leave a partially written avatar at the path used by the README.
for source in "$source_dir"/*.png; do
  [[ -f "$source" ]] || continue

  filename=$(basename "$source" .png)
  destination="$destination_dir/$filename.jpg"
  temporary="$destination_dir/.$filename.jpg.tmp"

  "${converter[@]}" "$source" \
    -background white \
    -alpha remove \
    -alpha off \
    -strip \
    -quality 90 \
    "jpg:$temporary"
  mv -- "$temporary" "$destination"
  converted=$((converted + 1))
  printf 'Converted %s -> %s\n' "$source" "$destination"
done

printf 'Converted %d avatar(s).\n' "$converted"
