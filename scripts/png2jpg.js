const fs = require('fs/promises');
const path = require('path');
const { randomUUID } = require('crypto');

// Fill incomplete 64x64 JPG fallbacks. Sharp is loaded only when generation is
// needed and is installed by the GitHub workflow, not declared as a repo dependency.
const root = path.resolve(__dirname, '..');
const sourceDirectory = path.join(root, 'profile', 'members', 'avatars', 'raw');
const destinationDirectory = path.join(root, 'profile', 'members', 'avatars', 'jpg');
const SUPPORTED_RAW_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg']);
const JPG_EXTENSIONS = new Set(['.jpg']);

async function imageNames(directory, extensions) {
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }

  return entries
    .filter((entry) => entry.isFile() && extensions.has(path.extname(entry.name).toLowerCase()))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
}

function normalizedBaseName(fileName) {
  return path.basename(fileName, path.extname(fileName)).toLowerCase();
}

async function hasJpegEnvelope(filePath) {
  try {
    const stats = await fs.lstat(filePath);
    if (stats.isSymbolicLink()) return false;
    if (!stats.isFile()) {
      throw new Error(`Expected a regular JPG file at ${filePath}`);
    }
    const file = await fs.open(filePath, 'r');
    try {
      if (stats.size < 4) return false;
      const [start, end] = await Promise.all([
        file.read(Buffer.alloc(2), 0, 2, 0),
        file.read(Buffer.alloc(2), 0, 2, stats.size - 2)
      ]);
      return start.bytesRead === 2 && end.bytesRead === 2 &&
        start.buffer[0] === 0xff && start.buffer[1] === 0xd8 &&
        end.buffer[0] === 0xff && end.buffer[1] === 0xd9;
    } finally {
      await file.close();
    }
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function inspectAvatars() {
  const rawNames = await imageNames(sourceDirectory, SUPPORTED_RAW_EXTENSIONS);
  const jpgNames = await imageNames(destinationDirectory, JPG_EXTENSIONS);
  const seen = new Map();
  const sources = rawNames.map((name) => {
    const baseName = normalizedBaseName(name);
    const previous = seen.get(baseName);
    if (previous) {
      throw new Error(`Raw avatar filenames collide after lowercase normalization: ${previous} and ${name}`);
    }
    seen.set(baseName, name);
    return { name, baseName };
  });

  const jpgCount = jpgNames.length;
  let incomplete = jpgCount < sources.length;
  for (const source of sources) {
    const destinationPath = path.join(destinationDirectory, `${source.baseName}.jpg`);
    if (!await hasJpegEnvelope(destinationPath)) incomplete = true;
  }

  return { sources, jpgCount, incomplete };
}

async function generateMissing(sources) {
  const sharp = require('sharp');
  await fs.mkdir(destinationDirectory, { recursive: true });
  let generatedCount = 0;

  for (const { name, baseName } of sources) {
    const sourcePath = path.join(sourceDirectory, name);
    const destinationPath = path.join(destinationDirectory, `${baseName}.jpg`);
    if (await hasJpegEnvelope(destinationPath)) {
      console.log(`Keeping existing valid JPG ${destinationPath}`);
      continue;
    }

    const temporaryPath = path.join(destinationDirectory, `.${baseName}.${process.pid}.${randomUUID()}.tmp`);
    try {
      await sharp(sourcePath)
        .resize(64, 64, { fit: 'cover' })
        .flatten({ background: '#ffffff' })
        .jpeg({ quality: 90 })
        .toFile(temporaryPath);
      if (!await hasJpegEnvelope(temporaryPath)) {
        throw new Error(`Sharp did not produce a valid JPEG for ${sourcePath}`);
      }
      await fs.rename(temporaryPath, destinationPath);
      generatedCount++;
      console.log(`Converted ${sourcePath} -> ${destinationPath}`);
    } finally {
      await fs.rm(temporaryPath, { force: true });
    }
  }

  return generatedCount;
}

async function main() {
  const checkOnly = process.argv[2] === '--check';
  if (process.argv.length > (checkOnly ? 3 : 2) || (process.argv[2] && !checkOnly)) {
    throw new Error('Usage: node scripts/png2jpg.js [--check]');
  }

  const { sources, jpgCount, incomplete } = await inspectAvatars();
  if (checkOnly) {
    console.log(incomplete ? 'true' : 'false');
    return;
  }
  if (sources.length === 0) {
    console.error(`No supported raw avatars found in ${sourceDirectory}; skipping JPG generation.`);
    return;
  }
  if (!incomplete) {
    console.log(`JPG fallbacks are complete (${jpgCount} JPGs for ${sources.length} raw avatars).`);
    return;
  }

  const generatedCount = await generateMissing(sources);
  console.log(`Generated ${generatedCount} missing or invalid JPG fallback(s) from ${sources.length} raw avatar(s).`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
