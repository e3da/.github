const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const root = path.resolve(__dirname, '..');
const csvPath = path.join(root, 'profile', 'members', 'profiles.csv');
const readmePath = path.join(root, 'profile', 'README.md');
const csvLines = fs.readFileSync(csvPath, 'utf8').trim().split('\n');
const readme = fs.readFileSync(readmePath, 'utf8');

function parseCsvLine(line) {
  const values = [];
  let value = '';
  let quoted = false;

  for (let index = 0; index < line.length; index++) {
    const character = line[index];
    if (character === '"' && line[index + 1] === '"') {
      value += '"';
      index++;
    } else if (character === '"') {
      quoted = !quoted;
    } else if (character === ',' && !quoted) {
      values.push(value);
      value = '';
    } else {
      value += character;
    }
  }

  values.push(value);
  return values;
}

if (csvLines[0] !== 'username,name,email,status,portfolio,avatar') {
  throw new Error('Unexpected profiles.csv header.');
}

const profiles = csvLines.slice(1).map(parseCsvLine);
const usernames = new Set();
let inactiveCount = 0;

async function validate() {
for (const [username, , , status, , avatar] of profiles) {
  if (!username || usernames.has(username)) throw new Error(`Invalid or duplicate username: ${username}`);
  usernames.add(username);

  if (status === 'Active') {
    if (!avatar.startsWith('members/avatars/jpg/') || !avatar.endsWith('.jpg')) {
      throw new Error(`Invalid active avatar path: ${username}`);
    }
    const avatarPath = path.join(root, 'profile', avatar);
    if (!fs.existsSync(avatarPath) || fs.statSync(avatarPath).size === 0) {
      throw new Error(`Missing active avatar: ${avatarPath}`);
    }
    const metadata = await sharp(avatarPath).metadata();
    if (metadata.format !== 'jpeg' || metadata.width !== 32 || metadata.height !== 32) {
      throw new Error(`Avatar must be a 32x32 JPEG: ${avatarPath}`);
    }
    const pngPath = path.join(root, 'profile', 'members', 'avatars', 'png', `${username}.png`);
    if (!fs.existsSync(pngPath) || fs.statSync(pngPath).size === 0) {
      throw new Error(`Missing source PNG avatar: ${pngPath}`);
    }
  } else if (status === 'Inactive' && avatar) {
    throw new Error(`Inactive member has an avatar path: ${username}`);
  } else if (status === 'Inactive') {
    inactiveCount++;
  } else if (status !== 'Active' && status !== 'Inactive') {
    throw new Error(`Unknown member status: ${status}`);
  }
}

if (!readme.includes('| Headshot | Member | Email | Portfolio |')) {
  throw new Error('README active-member table is missing or includes status.');
}

if (inactiveCount > 0 && !readme.includes('### Inactive Members\n\n| Member | Email | GitHub Profile |')) {
  throw new Error('README inactive-member table is missing or has the wrong columns.');
}

for (const [, name, , status, , avatar] of profiles) {
  if (status === 'Active' && !readme.includes(`(${avatar})`)) {
    throw new Error(`README is missing the avatar for ${name}.`);
  }
}

console.log(`Validated ${profiles.length} member profile records.`);
}

validate().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});