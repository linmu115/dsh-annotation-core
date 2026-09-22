import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { resolve, join, sep } from 'node:path';
import { create } from 'tar';

const root = resolve(import.meta.dirname, '..');
const plugin = root;
const manifest = JSON.parse(await readFile(join(plugin, 'package.json'), 'utf8'));
const out = join(root, '.artifacts');
await mkdir(out, { recursive: true });
const stage = await mkdtemp(join(out, '.release-'));
const target = join(stage, 'package');
const files = ["lib", "cordis.patch.yml", "README.md", "LICENSE"];
try {
  await mkdir(target, { recursive: true });
  for (const name of files) await cp(join(plugin, name), join(target, name), {
    recursive: true, filter: source => !source.endsWith('.map'),
  });
  const docTarget = join(target, 'docs');
  await mkdir(docTarget, { recursive: true });
  for (const entry of await readdir(join(plugin, 'docs'), { withFileTypes: true })) {
    if (entry.isFile() && /^(?:INSTALL|BUILD|RELEASE|cli-operations).*\.md$/.test(entry.name)) {
      await cp(join(plugin, 'docs', entry.name), join(docTarget, entry.name));
    }
  }
  for (const key of ['devDependencies', 'scripts', 'packageManager', 'pnpm']) delete manifest[key];
  for (const group of ['dependencies', 'peerDependencies']) {
    for (const [name, version] of Object.entries(manifest[group] ?? {})) {
      if (/^(file:|link:|workspace:)/.test(version)) throw new Error('Unbundled local dependency: ' + name);
    }
  }
  manifest.files = [...files, 'docs'];
  await writeFile(join(target, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
  const output = join(out, `${manifest.name.replace('@', '').replaceAll('/', '-')}-${manifest.version}.tgz`);
  await create({ cwd: stage, file: output, gzip: true, portable: true, noMtime: true }, ['package']);
  console.log(output);
} finally {
  if (!resolve(stage).startsWith(resolve(out) + sep)) throw new Error('Invalid package staging directory');
  await rm(stage, { recursive: true, force: true });
}
