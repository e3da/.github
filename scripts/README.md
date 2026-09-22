# Member Profile Scripts

## Avatar decisions

- Files in `profile/members/avatars/raw` are the committed, dynamically refreshed 128x128 downloads. Their extension reflects the actual image bytes.
- The README and CSV prefer raw PNG files and fall back to JPG only when a raw PNG is unavailable.
- Files in `profile/members/avatars/jpg` are independently decoded, resized to 64x64, and re-encoded as valid JPGs. JPG files are committed with the profile update.
- JPG generators normalize filenames to lowercase GitHub login names.
- The GitHub Action installs `sharp` on manual runs and fills missing JPG fallbacks. It does not add a Node dependency to this repository.
- `scripts/usr/bin/png2jpg.sh` remains the local ImageMagick utility. It reads `raw` sources and only converts PNG files; the Action uses `scripts/png2jpg.js` to avoid the larger ImageMagick installation.

## Main scripts

- `update-members.js` fetches active organization members, refreshes PNG avatars when requested, and regenerates `profiles.csv` and `profile/README.md`.
- `png2jpg.js` converts raw PNG and JPEG sources to temporary 64x64 JPG fallbacks without overwriting existing JPG entries.
- `validate-members.js` checks profile structure, avatar paths and file signatures, and README table references.
- `usr/bin/png2jpg.sh` provides local conversion modes: dry run (`0`), conversion (`1`), transactional pull/missing-JPG generation/validation/commit/push (`2`), and non-pushing conversion plus validation (`3`). It reads downloaded images from `raw`, converts them to 64x64 JPGs without overwriting existing JPG entries, and leaves profile README and CSV metadata to the Node workflow. Mode 2 preserves JPGs and profile data already present after the pull and generates only missing fallbacks.
- `usr/sbin/jpg2slapd.sh` pulls `origin/main` before diagnosing LDAP/JPG matches (`0`), exporting existing `jpegPhoto` values (`1`), importing selected E3DAIDs (`2`), importing all valid matches (`3`), or restoring JPGs from the default export directory (`5`) when the worktree is clean. Local changes skip the pull and use local JPGs. Mode 3 ignores extra arguments. When a JPG is missing, it prints the `png2jpg.sh 1` command needed to generate it. Mode 5 deletes LDAP photos whose `<uid>.jpg` is absent and prepares a compensating rollback if the LDAP modify fails. Read modes use anonymous LDAP access; write modes use the configurable LDAP admin DN and prompt for its password, without requiring sudo. It uses `uid` as E3DAID and requires a matching `labeledURI` GitHub Pages host before write modes operate.

Keep the generated JPG directory in commits after a successful manual conversion. Manual Action runs preserve existing JPGs and fill any missing fallbacks.
