const fs = require('fs/promises');
const path = require('path');
const { PROFILES_HEADER, parseCsvLine } = require('./csv');

// Fetch organization membership, preserve local profile data, and regenerate the
// CSV and README. PNG files are preferred because they are refreshed dynamically;
// local JPG files are temporary fallbacks used only when a PNG is unavailable.
const organization = 'e3da';
const pageSize = 100;
const root = path.resolve(__dirname, '..');
const membersDirectory = path.join(root, 'profile', 'members');
const csvPath = path.join(membersDirectory, 'profiles.csv');
const readmePath = path.join(root, 'profile', 'README.md');
const headerPath = path.join(root, 'profile', 'RM-head.md');
const token = process.env.GITHUB_TOKEN;
// Scheduled runs update member metadata only; manual runs also refresh PNG sources.
const updateAvatars = process.env.UPDATE_AVATARS === 'true';
const pngAvatarDirectory = path.join(membersDirectory, 'avatars', 'png');
const jpgAvatarDirectory = path.join(membersDirectory, 'avatars', 'jpg');

async function github(pathname, parameters = {}) {
  const url = new URL(`https://api.github.com${pathname}`);
  for (const [key, value] of Object.entries(parameters)) url.searchParams.set(key, value);

  const response = await fetch(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'e3da-member-profile-updater',
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    }
  });

  if (!response.ok) throw new Error(`GitHub API ${response.status}: ${url.pathname}${url.search}`);
  return response.json();
}

async function githubList(pathname, parameters = {}) {
  const items = [];
  for (let page = 1; ; page++) {
    const batch = await github(pathname, { ...parameters, page, per_page: pageSize });
    items.push(...batch);
    if (batch.length < pageSize) return items;
  }
}

function csv(value) {
  return `"${String(value ?? '').replaceAll('"', '""')}"`;
}

function markdown(value) {
  return String(value ?? '').replaceAll('|', '\\|').replaceAll('\n', ' ');
}

function portfolio(user) {
  return user.blog?.trim() || `https://${user.login.toLowerCase()}.github.io`;
}

function githubLogin(user) {
  return user.login.toLowerCase();
}

function normalizeLogin(login) {
  return String(login).toLowerCase();
}

async function readExistingProfiles() {
  try {
    const content = await fs.readFile(csvPath, 'utf8');
    const lines = content.trim().split('\n').slice(1).filter(Boolean);
    return new Map(lines.map((line) => {
      const [username, name, email, status, userPortfolio, avatar] = parseCsvLine(line);
      const normalizedUsername = normalizeLogin(username);
      return [normalizedUsername, {
        username: normalizedUsername,
        name,
        email,
        status,
        portfolio: userPortfolio,
        avatar
      }];
    }));
  } catch (error) {
    if (error.code === 'ENOENT') return new Map();
    throw error;
  }
}

async function fileExists(filePath) {
  return fs.access(filePath).then(() => true).catch((error) => {
    if (error.code === 'ENOENT') return false;
    throw error;
  });
}

async function downloadAvatar(user) {
  try {
    // Keep the original download separate from the locally generated JPG.
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

    const temporaryPath = `${pngPath}.tmp`;
    await fs.writeFile(temporaryPath, source);
    await fs.rename(temporaryPath, pngPath);
    return true;
  } catch (error) {
    console.warn(`Warning: could not update avatar for ${user.login}: ${error.message}`);
    return false;
  }
}

async function avatarPath(login) {
  const pngPath = path.join(pngAvatarDirectory, `${login}.png`);
  if (await fileExists(pngPath)) {
    return `members/avatars/png/${login}.png`;
  }

  const jpgPath = path.join(jpgAvatarDirectory, `${login}.jpg`);
  if (await fileExists(jpgPath)) {
    return `members/avatars/jpg/${login}.jpg`;
  }

  return '';
}

async function main() {
  const members = await githubList(`/orgs/${organization}/members`, { filter: 'all' });
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
    activeLogins.add(normalizeLogin(member.login));

    const user = await github(`/users/${encodeURIComponent(member.login)}`);
    const username = githubLogin(user);
    const previous = existingProfiles.get(username);
    if (updateAvatars) await downloadAvatar(user);
    profiles.set(username, {
      username,
      name: user.name || username,
      email: user.email || previous?.email || '',
      status: 'Active',
      portfolio: portfolio(user),
      avatar: await avatarPath(user.login)
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
      await fs.rm(path.join(jpgAvatarDirectory, `${profile.username}.jpg`), { force: true });
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