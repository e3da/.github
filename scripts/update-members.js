const fs = require('fs/promises');
const path = require('path');
const { PROFILES_HEADER, parseCsvLine } = require('./csv');

// Fetch organization membership, preserve local profile data, and regenerate the
// CSV and README. Raw downloaded images are preferred; JPG files are resized
// conversions used only when a raw image is not a PNG.
const organization = 'e3da';
const pageSize = 100;
const root = path.resolve(__dirname, '..');
const membersDirectory = path.join(root, 'profile', 'members');
const csvPath = path.join(membersDirectory, 'profiles.csv');
const readmePath = path.join(root, 'profile', 'README.md');
const headerPath = path.join(root, 'profile', 'RM-head.md');
const token = process.env.GITHUB_TOKEN;
// Scheduled runs update member metadata only; manual runs also refresh raw sources.
const updateAvatars = process.env.UPDATE_AVATARS === 'true';
const rawAvatarDirectory = path.join(membersDirectory, 'avatars', 'raw');
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

function imageExtension(source) {
  if (source.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return '.png';
  if (source.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return '.jpg';
  return '';
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

async function findAvatarPath(directory, login, extension) {
  const normalizedName = `${normalizeLogin(login)}${extension}`;
  let names;
  try {
    names = await fs.readdir(directory);
  } catch (error) {
    if (error.code === 'ENOENT') return '';
    throw error;
  }
  const matches = names.filter((candidate) => candidate.toLowerCase() === normalizedName);
  if (matches.length > 1) {
    throw new Error(`Ambiguous avatar files for ${login}: ${matches.join(', ')}`);
  }
  return matches.length === 1 ? path.join(directory, matches[0]) : '';
}

async function rawAvatarPaths(login) {
  let names;
  try {
    names = await fs.readdir(rawAvatarDirectory);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const normalizedLogin = normalizeLogin(login);
  return names
    .filter((name) => {
      const extension = path.extname(name).toLowerCase();
      const basename = path.basename(name, path.extname(name)).toLowerCase();
      return basename === normalizedLogin && ['.png', '.jpg', '.jpeg'].includes(extension);
    })
    .map((name) => path.join(rawAvatarDirectory, name));
}

async function assertUniqueRawAvatars() {
  const names = await fs.readdir(rawAvatarDirectory);
  const seen = new Map();
  for (const name of names) {
    const extension = path.extname(name).toLowerCase();
    if (!['.png', '.jpg', '.jpeg'].includes(extension)) continue;
    const basename = path.basename(name, path.extname(name)).toLowerCase();
    const previous = seen.get(basename);
    if (previous) throw new Error(`Duplicate raw avatar basename: ${previous} and ${name}`);
    seen.set(basename, name);
  }
}

async function downloadAvatar(user) {
  try {
    // Keep the original download separate from the locally generated JPG.
    const response = await fetch(`https://github.com/${user.login}.png?size=128`, {
      headers: { 'User-Agent': 'e3da-member-profile-updater' }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const source = Buffer.from(await response.arrayBuffer());
    const extension = imageExtension(source);
    if (!extension) throw new Error('response is not PNG or JPEG');
    const rawPath = path.join(rawAvatarDirectory, `${normalizeLogin(user.login)}${extension}`);
    const previousSource = await fs.readFile(rawPath).catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (previousSource?.equals(source)) return true;

    const temporaryPath = `${rawPath}.tmp`;
    await fs.writeFile(temporaryPath, source);
    await fs.rename(temporaryPath, rawPath);
    for (const existingPath of await rawAvatarPaths(user.login)) {
      if (existingPath !== rawPath) await fs.rm(existingPath, { force: true });
    }
    return true;
  } catch (error) {
    console.warn(`Warning: could not update avatar for ${user.login}: ${error.message}`);
    return false;
  }
}

async function avatarPath(login) {
  const rawPngPath = await findAvatarPath(rawAvatarDirectory, login, '.png');
  if (rawPngPath) {
    return `members/avatars/raw/${path.basename(rawPngPath)}`;
  }

  const rawJpgPath = await findAvatarPath(rawAvatarDirectory, login, '.jpg');
  if (rawJpgPath) {
    return `members/avatars/jpg/${normalizeLogin(login)}.jpg`;
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
  await fs.mkdir(rawAvatarDirectory, { recursive: true });
  await assertUniqueRawAvatars();

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
      await fs.rm(path.join(rawAvatarDirectory, `${profile.username}.png`), { force: true });
      await fs.rm(path.join(rawAvatarDirectory, `${profile.username}.jpg`), { force: true });
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