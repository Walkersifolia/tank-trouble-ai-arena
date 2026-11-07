import { createWriteStream } from 'node:fs';
import { mkdir, readFile, readdir, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import archiver from 'archiver';
import { kitFiles } from './package-ai-kit.mjs';

const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const require = createRequire(import.meta.url);
export const trainingPackageName = 'AI_Training_Arena_Windows_x64.zip';
export const trainingArchivePath = join(projectDir, 'local-data', 'packages', trainingPackageName);
const appFiles = [
  'devtools/training/server/training-server.cjs', 'devtools/training/server/training-preload.cjs', 'devtools/training/server/recordings.cjs',
  'devtools/training/runtime/index.html', 'devtools/training/runtime/runtime.js',
  'engine/arena/world.js', 'engine/arena/runner.js', 'engine/arena/observation.js',
  'engine/arena/sandbox.js', 'engine/arena/recording.js',
  'engine/config.js', 'engine/tank.js', 'engine/bullet.js', 'engine/mine.js', 'engine/powerup.js',
  'engine/rng.js',
  'engine/tank-motion.js', 'engine/vendor/planck.mjs', 'engine/vendor/planck.LICENSE.txt',
  'engine/laser.js', 'engine/collision.js', 'engine/maze.js', 'engine/upgrades.js', 'LICENSE',
];

export async function packageTrainingArena() {
  await mkdir(dirname(trainingArchivePath), { recursive: true });
  const output = createWriteStream(trainingArchivePath);
  const archive = archiver('zip', { zlib: { level: 6 } });
  const written = new Promise((done, fail) => {
    output.on('close', done); output.on('error', fail);
    archive.on('error', fail); archive.on('warning', fail);
  });
  archive.pipe(output);
  const prefix = 'AI_Training_Arena/';
  let unpackedBytes = 0;
  async function addFile(source, destination) {
    unpackedBytes += (await stat(source)).size;
    archive.file(source, { name: prefix + destination.replaceAll('\\', '/') });
  }
  function addText(text, destination) {
    unpackedBytes += Buffer.byteLength(text);
    archive.append(text, { name: prefix + destination });
  }
  async function addTree(source, destination, include = () => true) {
    for (const entry of await readdir(source, { withFileTypes: true })) {
      if (!include(entry)) continue;
      const from = join(source, entry.name), to = join(destination, entry.name);
      if (entry.isDirectory()) await addTree(from, to, include);
      else if (entry.isFile()) await addFile(from, to);
    }
  }

  // 复用本机已安装的官方 Electron；只保留中文和英文语言资源。
  const runtime = join(projectDir, 'node_modules', 'electron', 'dist');
  for (const entry of await readdir(runtime, { withFileTypes: true })) {
    if (entry.name === 'locales') continue;
    const source = join(runtime, entry.name), destination = join('runtime', entry.name);
    if (entry.isDirectory()) await addTree(source, destination);
    else if (entry.isFile()) await addFile(source, destination);
  }
  for (const locale of ['en-US.pak', 'zh-CN.pak']) {
    await addFile(join(runtime, 'locales', locale), `runtime/locales/${locale}`);
  }

  for (const file of appFiles) await addFile(join(projectDir, file), `app/${file}`);
  await addFile(join(projectDir, 'devtools', 'training', 'portable', 'launcher.cjs'), 'app/launcher.cjs');
  addText(JSON.stringify({ name: 'tank-training-arena', version: '1.0.0', private: true,
    type: 'module', main: 'launcher.cjs' }, null, 2), 'app/package.json');

  // 只收录本次授权的两个陪练；不使用整个网站 AI 清单作为训练包内容。
  const roster = JSON.parse(await readFile(join(projectDir, 'devtools', 'training', 'opponents.json'), 'utf8'));
  const opponents = [];
  for (const entry of roster) {
    const file = `bots/${entry.id}.js`;
    await addFile(resolve(projectDir, entry.file), `app/${file}`);
    opponents.push({ id: entry.id, name: entry.name, file });
  }
  addText(JSON.stringify(opponents, null, 2), 'app/devtools/training/opponents.json');

  // 日志 ZIP 沿用现有 archiver，仅收集它的实际生产依赖，不复制整个 node_modules。
  const dependencies = new Set();
  async function addDependency(name, fromRequire) {
    const packageFile = fromRequire.resolve(`${name}/package.json`);
    const directory = dirname(packageFile);
    if (dependencies.has(directory)) return;
    dependencies.add(directory);
    await addTree(directory, join('app', 'node_modules', relative(join(projectDir, 'node_modules'), directory)),
      entry => entry.name !== 'node_modules');
    const metadata = JSON.parse(await readFile(packageFile, 'utf8'));
    for (const dependency of Object.keys(metadata.dependencies || {})) {
      await addDependency(dependency, createRequire(packageFile));
    }
  }
  await addDependency('archiver', require);

  for (const file of ['trainer.mjs', 'API.md', 'RESULT_FORMAT.md']) {
    await addFile(join(projectDir, 'devtools', 'training', 'client', file), `client/${file}`);
  }
  for (const file of kitFiles) {
    await addFile(join(projectDir, file), 'workspace/' + file.slice('devtools/training/starter-kit/'.length));
  }
  for (const file of ['启动训练场.cmd', 'trainer.cmd', '打开训练终端.cmd', 'README.md', 'prompt.md']) {
    await addFile(join(projectDir, 'devtools', 'training', 'portable', file), file);
  }
  await Promise.all([archive.finalize(), written]);
  const size = (await stat(trainingArchivePath)).size;
  console.log(`完整本地训练场已生成：${trainingArchivePath}\nZIP ${(size / 1024 / 1024).toFixed(1)} MiB；解压约 ${(unpackedBytes / 1024 / 1024).toFixed(1)} MiB。内置陪练 ${opponents.length} 名。`);
  return trainingArchivePath;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  packageTrainingArena().catch(error => { console.error(`训练场打包失败：${error.message}`); process.exitCode = 1; });
}
