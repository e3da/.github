const fs = require('fs/promises');
const path = require('path');
const sharp = require('sharp');

// Fill missing 64x64 JPG fallbacks. sharp is installed only
// by that workflow and is not a repo dependency.
const root = path.resolve(__dirname, '..');
const sourceDirectory = path.join(root, 'profile', 'members', 'avatars', 'raw');
const destinationDirectory = path.join(root, 'profile', 'members', 'avatars', 'jpg');

async function main() {
  const sourceNames = (await fs.readdir(sourceDirectory)).sort();
  const imageNames = sourceNames.filter((name) => /\.(png|jpe?g)$/i.test(name));

  if (imageNames.length === 0) {
    throw new Error(`No PNG or JPEG avatars found in ${sourceDirectory}`);
  }

  await fs.mkdir(destinationDirectory, { recursive: true });
  const destinationNames = new Set();

  for (const sourceName of imageNames) {
    const extension = path.extname(sourceName).toLowerCase();
    const baseName = path.basename(sourceName, extension).toLowerCase();
    if (destinationNames.has(baseName)) {
      throw new Error(`PNG filenames collide after lowercase normalization: ${baseName}`);
    }
    destinationNames.add(baseName);
    const sourcePath = path.join(sourceDirectory, sourceName);
    const destinationPath = path.join(destinationDirectory, `${baseName}.jpg`);
    const temporaryPath = path.join(destinationDirectory, `.${baseName}.jpg.tmp`);

    if (await fs.lstat(destinationPath).then(() => true).catch((error) => {
      if (error.code === 'ENOENT') return false;
      throw error;
    })) {
      console.log(`Keeping existing ${destinationPath}`);
      continue;
    }

    await sharp(sourcePath)
      .resize(64, 64, { fit: 'cover' })
      .flatten({ background: '#ffffff' })
      .jpeg({ quality: 90 })
      .toFile(temporaryPath);
    await fs.rename(temporaryPath, destinationPath);
    console.log(`Converted ${sourcePath} -> ${destinationPath}`);
  }

  console.log(`Processed ${imageNames.length} avatar(s).`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
