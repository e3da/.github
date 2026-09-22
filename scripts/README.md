# Member Profile Scripts

## Avatar decisions

- PNG files in `profile/members/avatars/png` are the committed, dynamically refreshed sources.
- The README and CSV prefer PNG and fall back to JPG only when a PNG is unavailable.
- JPG files are generated manual-workflow fallbacks and are committed with the profile update so the conversion result is not lost.
- The GitHub Action installs `sharp` only when the JPG directory is absent. It does not add a Node dependency to this repository.
- `scripts/usr/bin/png2jpg.sh` remains the local ImageMagick utility. The Action uses `scripts/png2jpg.js` to avoid the larger ImageMagick installation.

## Main scripts

- `update-members.js` fetches active organization members, refreshes PNG avatars when requested, and regenerates `profiles.csv` and `profile/README.md`.
- `png2jpg.js` converts all PNG sources to temporary JPG fallbacks with atomic output replacement.
- `validate-members.js` checks profile structure, avatar paths and file signatures, and README table references.
- `usr/bin/png2jpg.sh` provides local conversion modes: dry run (`0`), conversion (`1`), transactional pull/commit/push (`2`), and non-pushing conversion plus metadata validation (`4`).

Keep the generated JPG directory in commits after a successful manual conversion. The Action only installs `sharp` and regenerates JPGs when that directory is absent.
