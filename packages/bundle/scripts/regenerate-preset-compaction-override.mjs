#!/usr/bin/env node
/**
 * Regenerate the preset-standard compaction override in ../cordis.patch.yml.
 *
 * dsh-app-boot's applyEntryPatches only descends entries marked `group: true`,
 * and `preset-standard` is not one. Its children therefore cannot be addressed
 * by id: `- id: compaction-basic` silently resolves to the disabled top-level
 * row instead of the preset's live one. The preset also mounts its compaction
 * service under `isolate: { compaction: true }`, so that inner copy is the one
 * agents actually use.
 *
 * The only supported override point is `preset-standard` itself, whose `config`
 * is replaced wholesale. That means carrying a copy of upstream's preset, so
 * this script rebuilds that copy from the tree dsh itself composes rather than
 * from a hand-edited snapshot. Re-run it after any upstream DSH upgrade:
 *
 *   node scripts/regenerate-preset-compaction-override.mjs
 *
 * It rewrites only the block between the BEGIN/END markers.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const webRoot = join(repoRoot, 'apps/web');
const patchFile = join(repoRoot, 'packages/bundle/cordis.patch.yml');
const BEGIN = '# BEGIN generated preset-standard compaction override';
const END = '# END generated preset-standard compaction override';

const dump = execFileSync(
  process.execPath,
  [join(webRoot, 'node_modules/@deepseek-ai/dsh/lib/bin.js'), '--profile', 'preview', '--dump-config'],
  { cwd: webRoot, env: { ...process.env, DSH_HOME: join(webRoot, '.test-runtime/preview') }, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
);

const lines = dump.split('\n');
const start = lines.findIndex((line) => line.trimEnd() === '- id: preset-standard');
if (start < 0) throw new Error('preset-standard is absent from the composed tree');
let end = lines.length;
for (let i = start + 1; i < lines.length; i += 1) {
  if (lines[i].startsWith('- ') || lines[i].startsWith('# ==')) { end = i; break; }
}

const block = lines.slice(start, end);
const configAt = block.findIndex((line) => line.startsWith('  config:'));
if (configAt < 0) throw new Error('preset-standard has no config to copy');

const override = ['- id: preset-standard', ...block.slice(configAt)];
const target = override.findIndex((line) => line.trim() === '- id: compaction-basic');
if (target < 0) throw new Error('the standard preset no longer mounts compaction-basic; upstream layout changed');
const nameLine = override[target + 1];
if (!nameLine?.includes('dsh-compaction-basic')) throw new Error(`unexpected entry after compaction-basic: ${nameLine}`);
const indent = ' '.repeat(nameLine.length - nameLine.trimStart().length);
override.splice(target + 2, 0, `${indent}config:`, `${indent}  headroomTokens: 8192`, `${indent}  maxTokens: 4096`);

const existing = readFileSync(patchFile, 'utf8');
const head = existing.includes(BEGIN) ? existing.slice(0, existing.indexOf(BEGIN)).trimEnd() : existing.trimEnd();
writeFileSync(patchFile, `${head}\n\n${BEGIN}\n${override.join('\n')}\n${END}\n`);
process.stdout.write(`regenerated preset-standard override: ${override.length} lines\n`);