# Member Profile Scripts

## Avatar decisions

- PNG files in `profile/members/avatars/png` are the committed, dynamically refreshed sources.
- The README and CSV prefer PNG and fall back to JPG only when a PNG is unavailable.
- JPG files are generated manual-workflow fallbacks and are committed with the profile update so the conversion result is not lost.
- JPG generators normalize filenames to lowercase GitHub login names.
- The GitHub Action installs `sharp` only when the JPG directory is absent. It does not add a Node dependency to this repository.
- `scripts/usr/bin/png2jpg.sh` remains the local ImageMagick utility. The Action uses `scripts/png2jpg.js` to avoid the larger ImageMagick installation.

## Main scripts

- `update-members.js` fetches active organization members, refreshes PNG avatars when requested, and regenerates `profiles.csv` and `profile/README.md`.
- `png2jpg.js` converts all PNG sources to temporary JPG fallbacks with atomic output replacement.
- `validate-members.js` checks profile structure, avatar paths and file signatures, and README table references.
- `usr/bin/png2jpg.sh` provides local conversion modes: dry run (`0`), conversion (`1`), transactional pull/missing-JPG generation/commit/push (`2`), and non-pushing conversion plus metadata validation (`3`). Mode 2 preserves JPGs already present after the pull and generates only missing fallbacks.
- `usr/sbin/jpg2slapd.sh` pulls `origin/main` before diagnosing LDAP/JPG matches (`0`), exporting existing `jpegPhoto` values (`1`), importing selected E3DAIDs (`2`), importing all valid matches (`3`), or restoring JPGs from the default export directory (`5`) when the worktree is clean. Local changes skip the pull and use local JPGs. Mode 3 ignores extra arguments. When a JPG is missing, it prints the `png2jpg.sh 1` command needed to generate it. Mode 5 deletes LDAP photos whose `<uid>.jpg` is absent and prepares a compensating rollback if the LDAP modify fails. Read modes use anonymous LDAP access; write modes use the configurable LDAP admin DN and prompt for its password, without requiring sudo. It uses `uid` as E3DAID and requires a matching `labeledURI` GitHub Pages host before write modes operate.

Keep the generated JPG directory in commits after a successful manual conversion. The Action only installs `sharp` and regenerates JPGs when that directory is absent.
