# Member Profile Scripts

## Avatar decisions

- Files in `profile/members/avatars/raw` are the committed, dynamically refreshed 128x128 downloads. Their extension reflects the actual image bytes.
- The README and CSV prefer raw PNG files and fall back to a generated JPG for raw JPEG sources (`.jpg` or `.jpeg`).
- Files in `profile/members/avatars/jpg` are independently decoded, resized to 64x64, and re-encoded as valid JPGs. JPG files are committed with the profile update.
- JPG generators normalize filenames to lowercase GitHub login names.
- The GitHub Action installs `sharp` only when fallback coverage is incomplete. It compares supported raw avatar files with generated JPGs, and repairs missing or invalid basename matches even when counts happen to be equal.
- The standalone ImageMagick utilities live outside this repository in the movable `getjpg` directory. Set `GITHUB_ROOT` to this repository before running `getjpg/bin/png2jpg.sh`; its local output is stored beside the script in `getjpg/bin/jpg`. The Action uses `scripts/png2jpg.js` to avoid requiring ImageMagick in CI.

## Main scripts

- `update-members.js` fetches active organization members, refreshes PNG avatars when requested, and regenerates `profiles.csv` and `profile/README.md`.
- `png2jpg.js` reports whether fallbacks are needed with `--check`; generation runs only when raw-to-JPG coverage is incomplete. It repairs missing/invalid expected JPGs using unique temporary files and atomic replacement, while preserving existing valid outputs. Manual ImageMagick mode 2 intentionally overwrites those tracked Sharp outputs with local conversions.
- `validate-members.js` checks profile structure, avatar paths and file signatures, and README table references; raw `.png`, `.jpg`, and `.jpeg` sources are supported. Missing or invalid generated JPG fallbacks fail validation; missing raw sources remain warnings.
- `getjpg/bin/png2jpg.sh` provides four modes: dry run (`0`); local-only conversion (`1`); prepare (`2`: pull `origin/main`, convert raw PNG/JPEG avatars into the local JPG folder, overwrite matching profile JPGs, then validate without committing or pushing); and publish (`3`: validate, commit prepared JPG changes, and push). Modes 0 and 1 treat `GITHUB_ROOT` as read-only. Mode 2 requires a clean, writable `main` checkout; mode 3 requires a writable checkout and refuses to commit staged changes outside the generated JPG directory. Local conversion refreshes all outputs from the raw sources, including raw JPEGs that need 64x64 downscaling.
- `getjpg/sbin/jpg2slapd.sh` reads JPGs from the local `getjpg/bin/jpg` folder (overridable with `JPG_DIRECTORY`) and never pulls or modifies the GitHub repository. It diagnoses LDAP/JPG matches (`0`), exports existing `jpegPhoto` values (`1`), imports selected E3DAIDs (`2`), imports all valid matches (`3`), or restores JPGs from the default export directory (`5`). Mode 3 ignores extra arguments. When a JPG is missing, it points to local conversion mode `1`; set `GITHUB_ROOT` for that converter. Mode 5 deletes LDAP photos whose `<uid>.jpg` is absent and prepares a compensating rollback if the LDAP modify fails. Read modes use anonymous LDAP access; write modes use the configurable LDAP admin DN and prompt for its password, without requiring sudo. It uses `uid` as E3DAID and requires a matching `labeledURI` GitHub Pages host before write modes operate.

Mode 2 intentionally leaves prepared tracked JPG changes uncommitted for review; run mode 3 to publish them. Profile README and CSV metadata remain managed by the Node workflow. Sharp preserves valid existing JPGs and fills only missing/invalid fallbacks; manual ImageMagick preparation is the explicit override path for replacing them.
