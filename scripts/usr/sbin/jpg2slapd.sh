#!/usr/bin/env bash
# ============================================================================
# Import GitHub member JPG avatars into the local OpenLDAP jpegPhoto attribute.
# E3DAID is the LDAP uid. Only users exactly one OU below ou=users with a valid
# labeledURI ending in github.io are eligible; direct users such as yrpeng are
# intentionally excluded.
# ============================================================================
set -Eeuo pipefail

DEFAULT_LDAP_URI="${LDAP_URI:-ldapi:///}"
LDAP_WRITE_URI="${LDAP_WRITE_URI:-ldap://peng-srv1.e3da.wx}"
LDAP_ADMIN_DN="${LDAP_ADMIN_DN:-cn=admin,dc=e3da,dc=top}"
LDAP_BASE="${LDAP_BASE:-ou=users,dc=e3da,dc=top}"
EXPECTED_LDAP_SERVER_HOSTNAME="peng-srv1"
CURRENT_HOSTNAME=$(hostname -s)
SCRIPT_DIRECTORY=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
ROOT_DIRECTORY=$(cd -- "$SCRIPT_DIRECTORY/../../.." && pwd)
JPG_DIRECTORY="${JPG_DIRECTORY:-$ROOT_DIRECTORY/profile/members/avatars/jpg}"
EXPORT_DIRECTORY="${EXPORT_DIRECTORY:-/tmp/jpg}"

usage() {
	cat <<EOF
Usage: $0 Mode [ModeArgs ...]

Mode:
	0: check LDAP users and JPG matches; no LDAP write
	1: export existing jpegPhoto to [EXPORT_DIRECTORY]/<E3DAID>.jpg
	2: import JPGs for selected E3DAIDs: Mode 2 <E3DAID> [E3DAID ...]
	3: import every JPG matching an eligible LDAP labeledURI; extra args ignored
	5: restore from [EXPORT_DIRECTORY], optionally limited to E3DAIDs

Mode 0/1: anonymous LDAP read; no password required.
Mode 2/3/5: LDAP admin write; prompt for the admin password.

Defaults:
	LDAP_URI=${DEFAULT_LDAP_URI}
	LDAP_WRITE_URI=${LDAP_WRITE_URI}
	LDAP_ADMIN_DN=${LDAP_ADMIN_DN}
	LDAP_BASE=${LDAP_BASE}
	JPG_DIRECTORY=${JPG_DIRECTORY}
	EXPORT_DIRECTORY=${EXPORT_DIRECTORY}
	Mode 5 backup directory=${EXPORT_DIRECTORY}

Notes:
	Only uid=<user>,ou=<group>,ou=users,... entries are eligible.
	labeledURI must identify <githubuser>.github.io.
	GitHub usernames and JPG names are matched case-insensitively.
	Mode 5 deletes jpegPhoto when its backup JPG is absent.
	Write modes bind as LDAP_ADMIN_DN and prompt for its password.
	The script must run on the LDAP server ($EXPECTED_LDAP_SERVER_HOSTNAME).
	The importer pulls origin/main when the worktree is clean; local changes skip the pull.
EOF
}

if (($# == 0)); then
	usage
	exit 0
fi

MODE=$1
shift
if [[ ! $MODE =~ ^[0-35]$ ]]; then
	printf 'ERROR: mode must be 0, 1, 2, 3, or 5.\n\n' >&2
	usage >&2
	exit 2
fi

if [[ $MODE == 2 && $# == 0 ]]; then
	printf 'ERROR: mode 2 requires at least one E3DAID.\n\n' >&2
	usage >&2
	exit 2
fi
if [[ $CURRENT_HOSTNAME != "$EXPECTED_LDAP_SERVER_HOSTNAME" ]]; then
	printf 'ERROR: this script must run on %s; current short hostname is %s.\n' \
		"$EXPECTED_LDAP_SERVER_HOSTNAME" "$CURRENT_HOSTNAME" >&2
	exit 1
fi

if ! command -v git >/dev/null 2>&1; then
	printf 'ERROR: required command not found: git\n' >&2
	exit 1
fi
if [[ -n $(git -c "safe.directory=$ROOT_DIRECTORY" -C "$ROOT_DIRECTORY" status --porcelain) ]]; then
	printf 'Local Git changes detected; skipping pull and using local JPGs.\n' >&2
else
	printf 'Pulling latest JPGs from origin/main...\n'
	if ! git -c "safe.directory=$ROOT_DIRECTORY" -C "$ROOT_DIRECTORY" pull --ff-only origin main; then
		printf 'Warning: repository update failed; using local JPGs.\n' >&2
	fi
fi

BACKUP_DIRECTORY=$EXPORT_DIRECTORY
RESTORE_UIDS=("$@")

required_commands=(ldapsearch)
if [[ $MODE == 1 || $MODE == 5 ]]; then
	required_commands+=(base64)
fi
if [[ $MODE == 2 || $MODE == 3 || $MODE == 5 ]]; then
	required_commands+=(ldapmodify realpath)
fi
for command_name in "${required_commands[@]}"; do
	if ! command -v "$command_name" >/dev/null 2>&1; then
		printf 'ERROR: required command not found: %s\n' "$command_name" >&2
		exit 1
	fi
done

LDAP_SEARCH=(ldapsearch -LLL -o ldif-wrap=no -x -H "$DEFAULT_LDAP_URI")

if [[ $MODE == 2 || $MODE == 3 || $MODE == 5 ]]; then
	LDAP_MODIFY=(ldapmodify -x -W -H "$LDAP_WRITE_URI" -D "$LDAP_ADMIN_DN")
fi

LDAP_DATA=$(mktemp)
LDAP_PHOTO_DATA=$(mktemp)
LDIF_FILE=$(mktemp)
ROLLBACK_LDIF_FILE=$(mktemp)
ROLLBACK_DIRECTORY=$(mktemp -d)
trap 'rm -f "$LDAP_DATA" "$LDAP_PHOTO_DATA" "$LDIF_FILE" "$ROLLBACK_LDIF_FILE"; rm -rf "$ROLLBACK_DIRECTORY"' EXIT

load_users() {
	if ! "${LDAP_SEARCH[@]}" -b "$LDAP_BASE" -s sub \
		'(&(objectClass=posixAccount)(uid=*))' uid uidNumber labeledURI jpegPhoto >"$LDAP_DATA"; then
		printf 'ERROR: LDAP search failed for %s\n' "$LDAP_BASE" >&2
		return 1
	fi
}

# Convert only records shaped like uid=user,ou=group,ou=users,... into tab-
# separated uid, uidNumber, URI, photo-present, DN. This excludes direct users
# under ou=users and deeper nested entries.
parse_users() {
	awk '
	function emit() {
		lower_dn = tolower(dn)
		if (uid != "" && lower_dn ~ /^uid=[^,]+,ou=[^,]+,ou=users,dc=e3da,dc=top$/) {
			print uid "\t" uri "\t" photo "\t" dn
		}
		uid = uri = dn = ""; photo = 0
	}
	/^dn: / { emit(); dn = substr($0, 5); next }
	/^uid: / { uid = substr($0, 6); next }
	/^labeledURI: / { uri = substr($0, 13); next }
	/^jpegPhoto::/ || /^jpegPhoto:/ { photo = 1; next }
	/^$/ { emit() }
	END { emit() }
	' "$LDAP_DATA"
}

declare -A USER_DN USER_URI USER_PHOTO USER_GITHUB JPG_BY_GITHUB
USER_ORDER=()
MISSING_JPG_COUNT=0

load_jpgs() {
	local file name key
	if [[ ! -d $JPG_DIRECTORY ]]; then
		return
	fi
	while IFS= read -r -d '' file; do
		name=$(basename "$file")
		name=${name%.*}
		key=${name,,}
		if [[ -n ${JPG_BY_GITHUB[$key]+x} ]]; then
			printf 'Warning: duplicate JPG login (case-insensitive): %s\n' "$name" >&2
		else
			JPG_BY_GITHUB[$key]=$file
		fi
	done < <(find "$JPG_DIRECTORY" -maxdepth 1 -type f \( -iname '*.jpg' -o -iname '*.jpeg' \) -print0 2>/dev/null)
}

print_missing_jpg_warning() {
	if (( MISSING_JPG_COUNT > 0 )); then
		printf '\nWarning: JPGs are missing for %d eligible LDAP user(s).\n' \
			"$MISSING_JPG_COUNT" >&2
		printf 'Generate all JPGs once with:\n  %s/scripts/usr/bin/png2jpg.sh 1\n' \
			"$ROOT_DIRECTORY" >&2
	fi
}

# Accept bare githubuser.github.io or an http(s) URL, but reject unrelated hosts.
github_login_from_uri() {
	local uri=$1 host
	host=${uri#http://}
	host=${host#https://}
	host=${host%%/*}
	host=${host,,}
	host=${host%.}
	if [[ $host =~ ^([a-z0-9][a-z0-9-]*)\.github\.io$ ]]; then
		printf '%s\n' "${BASH_REMATCH[1]}"
		return 0
	fi
	return 1
}

jpg_for_github() {
	local github=${1:-}
	if [[ -n $github ]]; then
		# GitHub logins are matched case-insensitively to LDAP hostnames and JPG names.
		printf '%s\n' "${JPG_BY_GITHUB[${github,,}]:-}"
	fi
}

valid_jpeg() {
	local file=$1 first last
	[[ -s $file ]] || return 1
	first=$(od -An -t x1 -N2 "$file" | tr -d ' \n')
	last=$(tail -c 2 "$file" | od -An -t x1 | tr -d ' \n')
	[[ $first == ffd8 && $last == ffd9 ]]
}

# LDIF file URLs let ldapmodify read local binary files without embedding them
# as base64. Paths are local and absolute because LDAP and the JPGs share host.
append_file_photo() {
	local ldif_file=$1 dn=$2 image_file=$3 absolute_file
	absolute_file=$(realpath -- "$image_file") || return 1
	if [[ $absolute_file == *[[:space:]\#\?%]* ]]; then
		printf 'ERROR: image path cannot be represented as an LDIF file URL: %s\n' \
			"$absolute_file" >&2
		return 1
	fi
	printf 'dn: %s\nchangetype: modify\nreplace: jpegPhoto\njpegPhoto:< file://%s\n\n' \
		"$dn" "$absolute_file" >>"$ldif_file"
}

append_photo_delete() {
	local ldif_file=$1 dn=$2
	printf 'dn: %s\nchangetype: modify\ndelete: jpegPhoto\n\n' "$dn" >>"$ldif_file"
}

decode_photo_to_file() {
	local dn=$1 output_file=$2
	if ! "${LDAP_SEARCH[@]}" -b "$dn" -s base '(objectClass=*)' jpegPhoto >"$LDAP_PHOTO_DATA"; then
		return 1
	fi
	if ! awk '/^jpegPhoto::/{sub(/^jpegPhoto::[ ]*/, ""); print; found=1} END { exit !found }' \
		"$LDAP_PHOTO_DATA" | tr -d '\n' | base64 -d >"$output_file"; then
		return 1
	fi
	valid_jpeg "$output_file"
}

load_users
load_jpgs

declare -a USER_ORDER
while IFS=$'\t' read -r uid uri photo dn; do
	[[ -n $uid ]] || continue
	USER_ORDER+=("$uid")
	USER_DN[$uid]=$dn
	USER_URI[$uid]=$uri
	USER_PHOTO[$uid]=$photo
	if [[ -n $uri ]]; then
		if github_user=$(github_login_from_uri "$uri") && [[ -n $github_user ]]; then
			USER_GITHUB[$uid]=$github_user
		fi
	fi
done < <(parse_users)

print_diagnostics() {
	local uid github file key
	declare -A MATCHED_JPGS=()
	printf '%s\n' 'Users without jpegPhoto:'
	for uid in "${USER_ORDER[@]}"; do
		if [[ ${USER_PHOTO[$uid]:-0} == 0 ]]; then
			printf '  %s%s\n' "$uid" "${USER_URI[$uid]:+ (labeledURI=${USER_URI[$uid]})}"
		fi
	done

	printf '%s\n' 'JPGs matching a valid LDAP labeledURI:'
	for uid in "${USER_ORDER[@]}"; do
		github=${USER_GITHUB[$uid]:-}
		file=$(jpg_for_github "$github")
		if [[ -n $github && -n $file ]]; then
			MATCHED_JPGS[$file]=1
			printf '  %s -> %s (%s)\n' "$(basename "$file")" "$uid" "${USER_URI[$uid]}"
		elif [[ -n $github ]]; then
			printf '  %s -> no JPG found (%s)\n' "$uid" "${USER_URI[$uid]}"
			MISSING_JPG_COUNT=$((MISSING_JPG_COUNT + 1))
		fi
	done

	printf '%s\n' 'JPGs without a matching LDAP user:'
	for key in "${!JPG_BY_GITHUB[@]}"; do
		file=${JPG_BY_GITHUB[$key]}
		if [[ -z ${MATCHED_JPGS[$file]+x} ]]; then
			printf '  %s\n' "$(basename "$file")"
		fi
	done
}

if [[ $MODE == 0 ]]; then
	print_diagnostics
	print_missing_jpg_warning
	exit 0
fi

if [[ $MODE == 1 ]]; then
	mkdir -p "$EXPORT_DIRECTORY"
	photo_count=0
	exported_count=0
	printf 'Exporting existing LDAP jpegPhoto values to %s\n' "$EXPORT_DIRECTORY"
	for uid in "${USER_ORDER[@]}"; do
		[[ ${USER_PHOTO[$uid]:-0} == 1 ]] || continue
		photo_count=$((photo_count + 1))
		temporary_file=$(mktemp "$EXPORT_DIRECTORY/.${uid}.jpg.XXXXXX")
		output_file="$EXPORT_DIRECTORY/$uid.jpg"
		if ! decode_photo_to_file "${USER_DN[$uid]}" "$temporary_file"; then
			printf 'Warning: could not read jpegPhoto for %s\n' "$uid" >&2
			rm -f "$temporary_file"
			continue
		fi
		mv -f -- "$temporary_file" "$output_file"
		printf 'Exported %s -> %s/%s.jpg\n' "$uid" "$EXPORT_DIRECTORY" "$uid"
		exported_count=$((exported_count + 1))
	done
	if (( photo_count == 0 )); then
		printf 'No eligible LDAP users currently have a jpegPhoto value.\n'
	else
		printf 'Exported %d of %d LDAP jpegPhoto value(s).\n' "$exported_count" "$photo_count"
	fi
	exit 0
fi

if [[ $MODE == 5 ]]; then
	if [[ ! -d $BACKUP_DIRECTORY ]]; then
		printf 'ERROR: backup directory does not exist: %s\n' "$BACKUP_DIRECTORY" >&2
		exit 1
	fi
	if ((${#RESTORE_UIDS[@]} == 0)); then
		RESTORE_UIDS=("${USER_ORDER[@]}")
	fi
	if ((${#RESTORE_UIDS[@]} == 0)); then
		printf 'No eligible LDAP users available to restore.\n'
		exit 0
	fi
	declare -A RESTORE_SEEN
	for uid in "${RESTORE_UIDS[@]}"; do
		if [[ -n ${RESTORE_SEEN[$uid]+x} ]]; then
			printf 'ERROR: duplicate E3DAID: %s\n' "$uid" >&2
			exit 2
		fi
		RESTORE_SEEN[$uid]=1
		if [[ -z ${USER_DN[$uid]+x} ]]; then
			printf 'ERROR: E3DAID is not a user one level below %s: %s\n' "$LDAP_BASE" "$uid" >&2
			exit 2
		fi
		backup_file="$BACKUP_DIRECTORY/$uid.jpg"
		if [[ -e $backup_file ]] && ! valid_jpeg "$backup_file"; then
			printf 'ERROR: invalid backup JPEG for %s: %s\n' "$uid" "$backup_file" >&2
			exit 1
		fi
	done

	# Build forward and compensating LDIF before the first write. A missing
	# backup image intentionally becomes a jpegPhoto deletion.
	: >"$LDIF_FILE"
	: >"$ROLLBACK_LDIF_FILE"
	for uid in "${RESTORE_UIDS[@]}"; do
		backup_file="$BACKUP_DIRECTORY/$uid.jpg"
		if [[ -e $backup_file ]]; then
			append_file_photo "$LDIF_FILE" "${USER_DN[$uid]}" "$backup_file" || exit 1
		else
			append_photo_delete "$LDIF_FILE" "${USER_DN[$uid]}"
		fi
		if [[ ${USER_PHOTO[$uid]:-0} == 1 ]]; then
			rollback_file=$(mktemp "$ROLLBACK_DIRECTORY/photo.XXXXXX.jpg")
			if ! decode_photo_to_file "${USER_DN[$uid]}" "$rollback_file"; then
				printf 'ERROR: rollback photo data missing for %s\n' "$uid" >&2
				exit 1
			fi
			append_file_photo "$ROLLBACK_LDIF_FILE" "${USER_DN[$uid]}" "$rollback_file" || exit 1
		else
			append_photo_delete "$ROLLBACK_LDIF_FILE" "${USER_DN[$uid]}"
		fi
		printf 'Prepared restore %s <- %s\n' "$uid" "${backup_file#$BACKUP_DIRECTORY/}"
	done

	if ! "${LDAP_MODIFY[@]}" <"$LDIF_FILE"; then
		printf 'ERROR: restore failed; attempting LDAP photo rollback.\n' >&2
		if ! "${LDAP_MODIFY[@]}" <"$ROLLBACK_LDIF_FILE"; then
			printf 'ERROR: LDAP photo rollback also failed. Review the directory immediately.\n' >&2
		fi
		exit 1
	fi
	printf 'Restored %d LDAP photo(s).\n' "${#RESTORE_UIDS[@]}"
	exit 0
fi

# Build one LDIF transaction. Each candidate is checked against both the LDAP
# labeledURI and JPEG magic bytes before it can change the directory.
: >"$LDIF_FILE"
selected=()
if [[ $MODE == 2 ]]; then
	selected=("$@")
else
	selected=("${USER_ORDER[@]}")
fi

for uid in "${selected[@]}"; do
	if [[ -z ${USER_DN[$uid]+x} ]]; then
		printf 'Warning: E3DAID not found at one users level: %s\n' "$uid" >&2
		continue
	fi
	github=${USER_GITHUB[$uid]:-}
	file=$(jpg_for_github "$github")
	if [[ -z $github || -z $file ]]; then
		[[ -n $github ]] && MISSING_JPG_COUNT=$((MISSING_JPG_COUNT + 1))
		continue
	fi
	if ! valid_jpeg "$file"; then
		printf 'Warning: invalid JPEG skipped for %s: %s\n' "$uid" "$file" >&2
		continue
	fi
	append_file_photo "$LDIF_FILE" "${USER_DN[$uid]}" "$file" || exit 1
	printf 'Prepared %s <- %s (%s)\n' "$uid" "$(basename "$file")" "${USER_URI[$uid]}"
done

if [[ ! -s $LDIF_FILE ]]; then
	print_missing_jpg_warning
	printf 'No matching valid JPG updates prepared.\n'
	exit 0
fi

print_missing_jpg_warning
printf 'Applying jpegPhoto updates via %s\n' "${LDAP_MODIFY[*]}"
"${LDAP_MODIFY[@]}" <"$LDIF_FILE"
