import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync, readdirSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

export function wrangler(args, json = false) {
  const cli = resolve('node_modules/wrangler/bin/wrangler.js');
  const result = spawnSync(process.execPath, [cli, ...args], {
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
  });
  if (result.error || result.status !== 0) throw new Error(result.error?.message || result.stderr || result.stdout);
  if (!json) return result.stdout;
  return JSON.parse(result.stdout);
}

export function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export function inspect(database, config, persist) {
  const query = (sql) => wrangler(['d1', 'execute', database, '--config', config,
    '--local', '--persist-to', persist, '--command', sql, '--json'], true);
  // D1 disallows integrity_check via its SQL API. Inspect the disposable local
  // SQLite file read-only after Wrangler has closed it; never touch live state.
  const files = readdirSync(persist, { recursive: true }).filter((name) =>
    name.endsWith('.sqlite') && !name.endsWith('metadata.sqlite'));
  if (files.length !== 1) throw new Error('Expected exactly one disposable SQLite database');
  const integrity = spawnSync('python3', ['-c',
    'import sqlite3,sys; from pathlib import Path; c=sqlite3.connect(Path(sys.argv[1]).as_uri()+"?mode=ro",uri=True); r=c.execute("PRAGMA integrity_check").fetchall(); print(r); sys.exit(0 if r==[("ok",)] else 1)',
    resolve(persist, files[0])], { encoding: 'utf8' });
  if (integrity.error || integrity.status !== 0) throw new Error('SQLite integrity check failed (python3 required)');
  if (query('PRAGMA foreign_key_check;')[0].results.length) throw new Error('Foreign key check failed');
  const tables = query("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name;")[0].results;
  return Object.fromEntries(tables.map(({ name }) => [name,
    query(`SELECT count(*) AS n FROM "${name.replaceAll('"', '""')}";`)[0].results[0].n]));
}

export function importSql(database, config, persist, sql) {
  const temporary = mkdtempSync(`${tmpdir()}/flaremmerce-import-`);
  chmodSync(temporary, 0o700);
  try {
    const prepared = resolve(temporary, 'snapshot.sql');
    const result = spawnSync('python3', [fileURLToPath(new URL('./prepare-d1-import.py', import.meta.url)), sql, prepared], { encoding: 'utf8' });
    if (result.error || result.status !== 0) throw new Error('Could not prepare exported SQL (complete Wrangler dump and python3 required)');
    try {
      return wrangler(['d1', 'execute', database, '--config', config, '--local',
        '--persist-to', persist, '--file', prepared, '--yes']);
    } catch {
      // Wrangler diagnostics may echo INSERT values, including auth secrets.
      throw new Error('Local snapshot import failed; SQL diagnostics withheld to protect credentials');
    }
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    database: { type: 'string', default: 'DB' }, config: { type: 'string', default: 'wrangler.jsonc' },
    remote: { type: 'boolean', default: false },
  } });
  if (positionals.length !== 1) throw new Error('Usage: node scripts/backup.mjs OUTPUT.sql [--database DB] [--config CONFIG] [--remote]');
  const output = resolve(positionals[0]);
  const manifestPath = `${output}.manifest.json`;
  if (existsSync(output) || existsSync(manifestPath)) throw new Error('Output or manifest already exists; use a new path');
  const started = Date.now();
  // Export has no supported --persist-to flag: local source is Wrangler default state.
  wrangler(['d1', 'export', values.database, '--config', values.config,
    values.remote ? '--remote' : '--local', '--output', output]);
  chmodSync(output, 0o600);
  const scratch = mkdtempSync(`${tmpdir()}/flaremmerce-backup-`);
  try {
    // Count the exported snapshot, never a concurrently changing live source.
    importSql(values.database, values.config, scratch, output);
    const tables = inspect(values.database, values.config, scratch);
    const manifest = { version: 1, createdAt: new Date().toISOString(),
      source: { database: values.database, config: resolve(values.config), mode: values.remote ? 'remote' : 'local' },
      sha256: sha256(output), bytes: readFileSync(output).length, tables,
      elapsedMs: Date.now() - started };
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    console.log(JSON.stringify({ output, manifestPath, ...manifest }, null, 2));
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
