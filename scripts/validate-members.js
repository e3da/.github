const fs = require('fs');
const path = require('path');
const { PROFILES_HEADER, parseCsvLine } = require('./csv');

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

async function validate() {
  for (const [username, , , status, , avatar] of profiles) {
    if (!username || usernames.has(username)) throw new Error(`Invalid or duplicate username: ${username}`);
    usernames.add(username);

    if (status === 'Active') {
      if (avatar) {
        if (!avatar.startsWith('members/avatars/png/') || !avatar.endsWith('.png')) {
          console.warn(`Warning: invalid active avatar path for ${username}: ${avatar}`);
          continue;
        }
        const avatarPath = path.join(root, 'profile', avatar);
        if (!fs.existsSync(avatarPath) || fs.statSync(avatarPath).size === 0) {
          console.warn(`Warning: missing active avatar: ${avatarPath}`);
        } else if (!validatePng(avatarPath)) {
          console.warn(`Warning: avatar is not a standard PNG: ${avatarPath}`);
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