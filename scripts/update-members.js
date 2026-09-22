const fs = require('fs/promises');
const path = require('path');
const { PROFILES_HEADER, parseCsvLine } = require('./csv');

const organization = 'e3da';
const root = path.resolve(__dirname, '..');
const membersDirectory = path.join(root, 'profile', 'members');
const csvPath = path.join(membersDirectory, 'profiles.csv');
const readmePath = path.join(root, 'profile', 'README.md');
const headerPath = path.join(root, 'profile', 'RM-head.md');
const token = process.env.GITHUB_TOKEN;
// Scheduled runs update member metadata only; manual runs also refresh avatars.
const updateAvatars = process.env.UPDATE_AVATARS === 'true';
const pngAvatarDirectory = path.join(membersDirectory, 'avatars', 'png');

async function github(pathname) {
  const response = await fetch(`https://api.github.com${pathname}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'e3da-member-profile-updater',
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    }
  });

  if (!response.ok) throw new Error(`GitHub API ${response.status}: ${pathname}`);
  return response.json();
}

function csv(value) {
  return `"${String(value ?? '').replaceAll('"', '""')}"`;
}

function markdown(value) {
  return String(value ?? '').replaceAll('|', '\\|').replaceAll('\n', ' ');
}

function portfolio(user) {
  return user.blog?.trim() || `https://${user.login}.github.io`;
}

async function readExistingProfiles() {
  try {
    const content = await fs.readFile(csvPath, 'utf8');
    const lines = content.trim().split('\n').slice(1).filter(Boolean);
    return new Map(lines.map((line) => {
      const [username, name, email, status, userPortfolio, avatar] = parseCsvLine(line);
      return [username, { username, name, email, status, portfolio: userPortfolio, avatar }];
    }));
  } catch (error) {
    if (error.code === 'ENOENT') return new Map();
    throw error;
  }
}

async function downloadAvatar(user) {
  try {
    // GitHub provides the required avatar directly, so no image conversion is needed.
    const response = await fetch(`https://github.com/${user.login}.png?size=64`, {
      headers: { 'User-Agent': 'e3da-member-profile-updater' }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const source = Buffer.from(await response.arrayBuffer());
    const pngPath = path.join(pngAvatarDirectory, `${user.login}.png`);
    const previousSource = await fs.readFile(pngPath).catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (previousSource?.equals(source)) return true;

    await fs.writeFile(pngPath, source);
    return true;
  } catch (error) {
    console.warn(`Warning: could not update avatar for ${user.login}: ${error.message}`);
    return false;
  }
}

async function main() {
  const members = await github(`/orgs/${organization}/members?per_page=100&filter=all`);
  if (members.length === 0) {
    throw new Error('GitHub returned no organization members; refusing to overwrite member profiles.');
  }
  const existingProfiles = await readExistingProfiles();
  const profiles = new Map(existingProfiles);
  const activeLogins = new Set();
  await fs.mkdir(pngAvatarDirectory, { recursive: true });

  for (const member of members) {
    const membership = await github(`/orgs/${organization}/memberships/${encodeURIComponent(member.login)}`);
    if (membership.role !== 'member' || membership.state !== 'active') continue;
    activeLogins.add(member.login);

    const user = await github(`/users/${encodeURIComponent(member.login)}`);
    const previous = existingProfiles.get(user.login);
    const previousAvatarPath = previous?.avatar ? path.join(root, 'profile', previous.avatar) : '';
    const hasPreviousAvatar = previousAvatarPath && await fs.access(previousAvatarPath).then(() => true).catch(() => false);
    const avatarUpdated = updateAvatars ? await downloadAvatar(user) : false;
    // Keep a missing avatar during scheduled runs; a manual run populates it.
    profiles.set(user.login, {
      username: user.login,
      name: user.name || user.login,
      email: user.email || previous?.email || '',
      status: 'Active',
      portfolio: portfolio(user),
      avatar: avatarUpdated || hasPreviousAvatar ? `members/avatars/png/${user.login}.png` : ''
    });
  }

  for (const profile of profiles.values()) {
    if (!activeLogins.has(profile.username)) {
      const previousAvatar = profile.avatar;
      profile.status = 'Inactive';
      profile.avatar = '';
      if (previousAvatar) {
        await fs.rm(path.join(root, 'profile', previousAvatar), { force: true });
      }
      await fs.rm(path.join(pngAvatarDirectory, `${profile.username}.png`), { force: true });
    }
  }

  const sortedProfiles = [...profiles.values()].sort((left, right) => left.name.localeCompare(right.name));

  const csvContent = [
    PROFILES_HEADER,
    ...sortedProfiles.map((profile) =>
      [profile.username, profile.name, profile.email, profile.status, profile.portfolio, profile.avatar]
        .map(csv)
        .join(',')
    )
  ].join('\n') + '\n';
  await fs.writeFile(csvPath, csvContent);

  const activeRows = sortedProfiles.filter((profile) => profile.status === 'Active').map((profile) =>
    `| ${profile.avatar ? `<img src="${profile.avatar}" width="32" height="32" style="border-radius: 50%;" alt="Profile Image">` : '-'} | **[${markdown(profile.name)}](https://github.com/${profile.username})** | [${markdown(profile.portfolio)}](${profile.portfolio}) |`
  );
  const activeTable = [
    '| Headshot | Member | Portfolio |',
    '| :---: | :--- | :--- |',
    ...(activeRows.length ? activeRows : ['| - | No active members found | - |'])
  ].join('\n');
  const inactiveRows = sortedProfiles.filter((profile) => profile.status === 'Inactive').map((profile) =>
    `| **[${markdown(profile.name)}](https://github.com/${profile.username})** | https://github.com/${profile.username} |`
  );
  const inactiveTable = inactiveRows.length ? `\n\n### Inactive Members\n\n| Member | GitHub Profile |\n| :--- | :--- |\n${inactiveRows.join('\n')}` : '';
  const header = await fs.readFile(headerPath, 'utf8');
  const newContent = `${header.trimEnd()}\n\n${activeTable}${inactiveTable}\n\n*Last updated: ${new Date().toUTCString()} (via ubuntu-slim)*\n`;
  await fs.writeFile(readmePath, newContent);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});