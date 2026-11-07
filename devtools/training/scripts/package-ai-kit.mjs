import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import archiver from 'archiver';

const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
// 只分发公开开发资料，不将主项目、参赛选手或训练数据打入工具包。
export const kitFiles = [
  'README.md', 'API.md', 'DEVELOPMENT.md', 'prompt.md',
  'bot.js', 'check.js', 'example_state.json', 'package.json',
  'examples/pivot.js', 'examples/patrol.js',
].map(file => `devtools/training/starter-kit/${file}`);

export async function packageAIKit() {
  const archivePath = resolve(projectDir, 'downloads', 'AI_Starter_Kit.zip');
  await mkdir(dirname(archivePath), { recursive: true });
  const output = createWriteStream(archivePath);
  const archive = archiver('zip', { zlib: { level: 6 } });
  const written = new Promise((done, fail) => {
    output.on('close', done);
    output.on('error', fail);
    archive.on('error', fail);
    archive.on('warning', fail);
  });
  archive.pipe(output);
  for (const file of kitFiles) archive.file(resolve(projectDir, file), {
    name: 'AI_Starter_Kit/' + file.slice('devtools/training/starter-kit/'.length),
  });
  await Promise.all([archive.finalize(), written]);
  console.log(`开发工具包已生成：${archivePath}`);
  return archivePath;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  packageAIKit().catch(error => { console.error(`工具包打包失败：${error.message}`); process.exitCode = 1; });
}
