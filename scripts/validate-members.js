const fs = require('fs');
const path = require('path');
const { PROFILES_HEADER, parseCsvLine } = require('./csv');

// Validate profile structure, referenced avatar files, and generated README tables.
const root = path.resolve(__dirname, '..');
const csvPath = path.join(root, 'profile', 'members', 'profiles.csv');
const readmePath = path.join(root, 'profile', 'README.md');
const csvLines = fs.readFileSync(csvPath, 'utf8').trim().split('\n');
const readme = fs.readFileSync(readmePath, 'utf8');

if (csvLines[0] !== PROFILES_HEADER) {
  throw new Error('Unexpected profiles.csv header.');
}

const profiles = csvLines.slice(1).map(parseCsvLine);
const usernames = new Set();
let inactiveCount = 0;

function validateRawAvatarNames() {
  const seen = new Map();
  const rawDirectory = path.join(root, 'profile', 'members', 'avatars', 'raw');
  if (!fs.existsSync(rawDirectory)) return;
  for (const name of fs.readdirSync(rawDirectory)) {
    const extension = path.extname(name).toLowerCase();
    if (!['.png', '.jpg', '.jpeg'].includes(extension)) continue;
    const basename = path.basename(name, path.extname(name)).toLowerCase();
    if (seen.has(basename)) {
      throw new Error(`Duplicate raw avatar basename: ${seen.get(basename)} and ${name}`);
    }
    seen.set(basename, name);
  }
}

function validatePng(filePath) {
  try {
    // Validate the PNG when possible, but avatar quality must not block the update.
    const content = fs.readFileSync(filePath);
    const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    if (content.length < 24 || !content.subarray(0, 8).equals(signature)) return false;
    if (content.toString('ascii', 12, 16) !== 'IHDR') return false;
    return content.readUInt32BE(16) > 0 && content.readUInt32BE(20) > 0;
  } catch {
    return false;
  }
}

// Raw downloads keep their detected extension; generated JPGs are always
// independently re-encoded fallback files.
function validateJpg(filePath) {
  try {
    const content = fs.readFileSync(filePath);
    return content.length >= 4 && content[0] === 0xff && content[1] === 0xd8 &&
      content[content.length - 2] === 0xff && content[content.length - 1] === 0xd9;
  } catch {
    return false;
  }
}

async function validate() {
  validateRawAvatarNames();
  for (const [username, , , status, , avatar] of profiles) {
    const normalizedUsername = String(username || '').toLowerCase();
    if (!normalizedUsername || usernames.has(normalizedUsername)) {
      throw new Error(`Invalid or duplicate username: ${username}`);
    }
    usernames.add(normalizedUsername);

    if (status === 'Active') {
      if (avatar) {
        const isRawPng = avatar.startsWith('members/avatars/raw/') && avatar.endsWith('.png');
        const isRawJpg = avatar.startsWith('members/avatars/raw/') && avatar.endsWith('.jpg');
        const isJpg = avatar.startsWith('members/avatars/jpg/') && avatar.endsWith('.jpg');
        if (!isRawPng && !isRawJpg && !isJpg) {
          console.warn(`Warning: invalid active avatar path for ${username}: ${avatar}`);
          continue;
        }
        const avatarPath = path.join(root, 'profile', avatar);
        if (!fs.existsSync(avatarPath) || fs.statSync(avatarPath).size === 0) {
          console.warn(`Warning: missing active avatar: ${avatarPath}`);
        } else if (isRawPng ? !validatePng(avatarPath) : !validateJpg(avatarPath)) {
          console.warn(`Warning: avatar is not a valid ${isRawPng ? 'PNG' : 'JPG'}: ${avatarPath}`);
        }
      }
    } else if (status === 'Inactive' && avatar) {
      throw new Error(`Inactive member has an avatar path: ${username}`);
    } else if (status === 'Inactive') {
      inactiveCount++;
    } else if (status !== 'Active' && status !== 'Inactive') {
      throw new Error(`Unknown member status: ${status}`);
    }
  }

  if (!readme.includes('| Headshot | Member | Portfolio |')) {
    throw new Error('README active-member table is missing or includes status.');
  }

  if (inactiveCount > 0 && !readme.includes('### Inactive Members\n\n| Member | GitHub Profile |')) {
    throw new Error('README inactive-member table is missing or has the wrong columns.');
  }

  for (const [, name, , status, , avatar] of profiles) {
    if (status === 'Active' && avatar && !readme.includes(`src="${avatar}" width="32" height="32" style="border-radius: 50%;"`)) {
      console.warn(`Warning: README is missing the avatar for ${name}.`);
    }
  }

  console.log(`Validated ${profiles.length} member profile records.`);
}

validate().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});