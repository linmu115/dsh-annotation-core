import { access, lstat, readFile, realpath, symlink } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const expectedVersion = '0.2.1-rc.3';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const input = process.argv[2] || process.env.DSH_HOST_SOURCE;
if (!input) throw new Error('Set DSH_HOST_SOURCE or pass the built DSH source directory as the first argument.');
const source = await realpath(resolve(input));
const manifest = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'));
if (manifest.name !== '@deepseek-ai/dsh-root' || manifest.version !== expectedVersion) {
  throw new Error(`Expected @deepseek-ai/dsh-root ${expectedVersion}; received ${manifest.name} ${manifest.version}.`);
}
const local = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
for (const [name, specifier] of Object.entries(local.devDependencies ?? {})) {
  if (!specifier.startsWith('link:.dsh-host/')) continue;
  const location = resolve(source, specifier.slice('link:.dsh-host/'.length));
  if (!location.startsWith(source + sep)) throw new Error(`Host dependency escaped its root: ${name}`);
  const dependency = JSON.parse(await readFile(join(location, 'package.json'), 'utf8'));
  if (dependency.name !== name || (name.startsWith('@deepseek-ai/dsh-') && dependency.version !== expectedVersion)) {
    throw new Error(`Unexpected host dependency: ${name} resolves to ${dependency.name} ${dependency.version}.`);
  }
  // Verify this is a built source checkout before changing the local link.
  await access(join(location, dependency.main ?? 'lib/index.js'));
}
const target = join(root, '.dsh-host');
let current;
try { current = await lstat(target); } catch (error) { if (error.code !== 'ENOENT') throw error; }
if (current) {
  if (!current.isSymbolicLink() || await realpath(target) !== source) {
    throw new Error('.dsh-host already points elsewhere; choose the intended host and remove only that local link before retrying.');
  }
} else {
  await symlink(source, target, process.platform === 'win32' ? 'junction' : 'dir');
}
console.log(`Prepared DSH ${expectedVersion} through .dsh-host`);
