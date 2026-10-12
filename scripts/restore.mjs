import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve, dirname, basename, join } from 'node:path';
import { realpathSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { sha256, importSql, inspect } from './backup.mjs';

try {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    database: { type: 'string' }, config: { type: 'string', default: 'wrangler.jsonc' },
    'persist-to': { type: 'string' },
  } });
  if (positionals.length !== 1 || !values.database || !values['persist-to']) {
    throw new Error('Usage: node scripts/restore.mjs INPUT.sql --database DB --persist-to NEW_DIRECTORY [--config CONFIG]; local only');
  }
  const sql = resolve(positionals[0]);
  const target = resolve(values['persist-to']);
  // Require a new directory; canonical parent resolves symlink aliases of live state.
  const canonical = join(realpathSync(dirname(target)), basename(target));
  const live = resolve('.wrangler');
  if (existsSync(target) || canonical === live || canonical.startsWith(`${live}/`)) {
    throw new Error('Target must be a nonexistent directory outside .wrangler; existing resources are never overwritten');
  }
  const manifest = JSON.parse(readFileSync(`${sql}.manifest.json`, 'utf8'));
  if (manifest.version !== 1 || !manifest.tables || manifest.sha256 !== sha256(sql)
    || manifest.bytes !== readFileSync(sql).length) throw new Error('Manifest/checksum validation failed');
  const started = Date.now();
  mkdirSync(target, { mode: 0o700 });
  importSql(values.database, values.config, target, sql);
  const tables = inspect(values.database, values.config, target);
  if (JSON.stringify(tables) !== JSON.stringify(manifest.tables)) throw new Error('Table counts differ from exported snapshot');
  console.log(JSON.stringify({ localOnly: true, target, database: values.database,
    integrity: 'ok', foreignKeys: 'ok', sha256: manifest.sha256, tables,
    elapsedMs: Date.now() - started }, null, 2));
} catch (error) { console.error(error.message); process.exitCode = 1; }
