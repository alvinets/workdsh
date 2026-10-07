import { execFile } from 'node:child_process';
import { access, copyFile, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { withoutRedundantAgentTeamProfile } from './preview-agent-team.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const rootManifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const baseVersion = rootManifest.pnpm?.overrides?.['@deepseek-ai/dsh-base'];
const webAppVersion = rootManifest.pnpm?.overrides?.['@deepseek-ai/dsh-web-app'];
if (typeof baseVersion !== 'string') throw new Error('Missing pinned @deepseek-ai/dsh-base version in package.json pnpm.overrides.');
if (typeof webAppVersion !== 'string') throw new Error('Missing pinned @deepseek-ai/dsh-web-app version in package.json pnpm.overrides.');
const baseSpec = `@deepseek-ai/dsh-base@${baseVersion}`;
const webAppSpec = `@deepseek-ai/dsh-web-app@${webAppVersion}`;
const cliVersion = JSON.parse(await readFile(join(root, 'node_modules/@deepseek-ai/dsh/package.json'), 'utf8')).version;
if (cliVersion !== baseVersion) throw new Error('Preview CLI and Base must use the same pinned version.');
const home = resolve(process.env.WORKDSH_PREVIEW_HOME ?? join(root, '.test-runtime/preview'));
const artifacts = join(root, '.artifacts');
// The preview Profile is itself a pnpm workspace root, and `dsh plugin add`
// forwards to `pnpm add` without `-w`, which pnpm >=10 rejects with
// ERR_PNPM_ADDING_TO_ROOT. Every add targets this Profile deliberately, so
// acknowledge the workspace root instead of patching the generated tree.
const env = { ...process.env, DSH_HOME: home, npm_config_ignore_workspace_root_check: 'true', PATH: `${join(root, 'node_modules/.bin')}:${dirname(process.execPath)}:${process.env.PATH}` };
const exec = promisify(execFile);
const run = async (tool, args) => {
  await exec(process.execPath, [join(root, 'node_modules', tool), ...args], { cwd: root, env, timeout: 180_000, maxBuffer: 8 * 1024 * 1024 });
};
await mkdir(home, { recursive: true }); await mkdir(artifacts, { recursive: true });
const tarballs = [];
const packages = [];
for (const directory of ['packages/providers/identity-local', 'packages/plugins/audit', 'packages/plugins/access', 'packages/plugins/skills', 'packages/plugins/experts', 'packages/plugins/connectors', 'packages/plugins/office', 'packages/plugins/library', 'packages/plugins/projects', 'packages/plugins/activity', 'packages/bundle']) {
  const manifest = JSON.parse(await readFile(join(root, directory, 'package.json'), 'utf8'));
  await access(join(root, directory, manifest.exports['.'].default));
  await run('pnpm/bin/pnpm.cjs', ['--filter', manifest.name, 'pack', '--pack-destination', artifacts]);
  const packed = join(artifacts, `${manifest.name}-${manifest.version}.tgz`);
  // Preview candidates can change before their next release. A stable file:
  // address lets the package manager reuse an older archive, even after pack.
  // Keep official CLI installation, but address each archive by its content.
  const digest = createHash('sha256').update(await readFile(packed)).digest('hex');
  const destination = join(artifacts, 'preview', digest);
  await mkdir(destination, { recursive: true });
  const immutableArchive = join(destination, `${manifest.name}-${manifest.version}.tgz`);
  await copyFile(packed, immutableArchive);
  tarballs.push(immutableArchive);
  packages.push({ directory, manifest });
}
let initialized = false;
try { await access(join(home, 'profiles/preview/package.json')); initialized = true; }
catch (error) { if (error.code !== 'ENOENT') throw error; }
if (!initialized) await run('@deepseek-ai/dsh/lib/bin.js', ['--profile', 'preview', '--from-default-profile', 'web', '--dump-config']);
// Experts already contributes the official Team service, tools and Web action.
// The standalone Team profile adds the same loader ids again and can be toggled
// on from the upstream plugin gallery. Keep this preview's bundle list singular.
const previewManifestPath = join(home, 'profiles/preview/package.json');
const previewManifest = JSON.parse(await readFile(previewManifestPath, 'utf8'));
const normalizedManifest = withoutRedundantAgentTeamProfile(previewManifest);
if (normalizedManifest) {
  await writeFile(previewManifestPath, `${JSON.stringify(normalizedManifest, null, 2)}\n`);
  console.log('Removed redundant standalone Agent Team profile from preview; WorkDSH experts owns Team composition.');
}
// Reinstall the pinned official Web bundle as well as the WorkDSH layers. An
// existing preview Profile may have been created by an older DSH release; its
// bundle list alone does not upgrade the packages that provide newly added Web
// surfaces such as Terminal and archived-session recovery.
await run('@deepseek-ai/dsh/lib/bin.js', ['plugin', '--profile', 'preview', 'add', baseSpec, webAppSpec, ...tarballs]);
// Boot and ConfigEditor share module-local registration in dsh-app-boot.
// Keep the official CLI in the Profile dependency graph as well: launching the
// workspace CLI beside separately installed Profile packages splits that state.
// Profiles disable automatic peer installation. The platform account adapter
// also needs its declared native account peer in this standalone runtime.
await run('pnpm/bin/pnpm.cjs', ['--dir', join(home, 'profiles/preview'), 'add', '--save-exact', `@deepseek-ai/dsh@${cliVersion}`, `@deepseek-ai/dsh-deepseek-account@${cliVersion}`]);
const installedBase = JSON.parse(await readFile(join(home, 'profiles/preview/node_modules/@deepseek-ai/dsh-base/package.json'), 'utf8'));
if (installedBase.version !== baseVersion) throw new Error(`Installed @deepseek-ai/dsh-base ${installedBase.version} does not match pinned ${baseVersion}.`);
const installedWebApp = JSON.parse(await readFile(join(home, 'profiles/preview/node_modules/@deepseek-ai/dsh-web-app/package.json'), 'utf8'));
if (installedWebApp.version !== webAppVersion) throw new Error(`Installed @deepseek-ai/dsh-web-app ${installedWebApp.version} does not match pinned ${webAppVersion}.`);
// DSH scopes are module-instance local. Installing only the Web bundle
// beside a CLI-provided Base bundle can load two physical dsh-scope copies: the
// Agent consumers must resolve one shared scope module; otherwise new
// session fails as an "unscoped context". Resolve both consumers from the
// Profile and fail installation unless they share the exact same module file.
const profileRequire = createRequire(join(home, 'profiles/preview/package.json'));
const resolveProfileDependency = async (consumer, dependency) => {
  const consumerManifest = profileRequire.resolve(`${consumer}/package.json`);
  const consumerRequire = createRequire(consumerManifest);
  return realpath(consumerRequire.resolve(`${dependency}/package.json`));
};
const cliBoot = await resolveProfileDependency('@deepseek-ai/dsh', '@deepseek-ai/dsh-app-boot');
const settingsBoot = await resolveProfileDependency('@deepseek-ai/dsh-config-editor', '@deepseek-ai/dsh-app-boot');
if (cliBoot !== settingsBoot) throw new Error('Preview CLI and ConfigEditor resolve different dsh-app-boot instances; settings cannot persist.');
const loopScope = await resolveProfileDependency('@deepseek-ai/dsh-agent-loop', '@deepseek-ai/dsh-scope');
const presetScope = await resolveProfileDependency('@deepseek-ai/dsh-agent-preset-registry', '@deepseek-ai/dsh-scope');
if (loopScope !== presetScope) throw new Error(`Preview loaded split @deepseek-ai/dsh-scope instances: agent-loop=${loopScope}; agent-preset-registry=${presetScope}.`);
for (const { directory, manifest } of packages) {
  for (const face of ['.', './client']) {
    const entry = manifest.exports[face]?.default;
    if (!entry) continue;
    const expected = await readFile(join(root, directory, entry));
    const installed = await readFile(join(home, 'profiles/preview/node_modules', manifest.name, entry));
    if (!expected.equals(installed)) throw new Error(`Installed ${manifest.name} ${face} differs from the current build; refusing to report a successful preview update.`);
  }
}
// A bundle whose peerDependencies miss the runtime version is dropped from the
// composed tree SILENTLY (loadProfileDirectory collects it without printing),
// which presents as an empty sidebar with no error anywhere. dsh takes the
// runtime version from dsh-app-boot's own package.json, so a dsh installed by
// npm (whose ^0.1.7-alpha.1 range resolves up to 0.1.7-rc.2) silently discards
// every WorkDSH layer. Resolve the layers exactly as the launcher does and
// refuse to report success while any declared bundle is absent.
// Anchor on the real path: the CLI is a pnpm symlink, and CommonJS resolution
// does not follow it into .pnpm, so app-boot would be unresolvable.
const repoRequire = createRequire(await realpath(join(root, 'node_modules/@deepseek-ai/dsh/package.json')));
const { loadProfileDirectory } = await import(repoRequire.resolve('@deepseek-ai/dsh-app-boot'));
const declaredBundles = JSON.parse(await readFile(join(home, 'profiles/preview/package.json'), 'utf8')).dsh?.profile?.bundles ?? [];
const loadedBundles = new Set(loadProfileDirectory('dsh', join(home, 'profiles/preview'), join(root, 'node_modules/@deepseek-ai/dsh/package.json')).layers.map((layer) => layer.packageName));
const missingBundles = declaredBundles.filter((name) => !loadedBundles.has(name));
if (missingBundles.length > 0) {
  const runtimeVersion = JSON.parse(await readFile(repoRequire.resolve('@deepseek-ai/dsh-app-boot/package.json'), 'utf8')).version;
  throw new Error(`Preview bundles did not load: ${missingBundles.join(', ')}\n`
    + `dsh runtime version is ${runtimeVersion}. Launch the preview with this repository's CLI `
    + `(node_modules/@deepseek-ai/dsh/lib/bin.js), never a global npm install of @deepseek-ai/dsh: `
    + `npm resolves its ^0.1.7-alpha.1 dependency range to a newer prerelease, and every bundle whose `
    + `peerDependencies do not satisfy that version is dropped without a diagnostic.`);
}
console.log('Installed Skill, Expert, Connector, Office, Library, Projects and WorkDSH presentation as separate official Profile layers.');
console.log('Start the stopped preview with: corepack pnpm preview');
