import { expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, readFileSync, symlinkSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

it('restores populated missing-parent exports with real D1, preserving SQL and triggers', () => {
  const root = resolve('.');
  const cwd = mkdtempSync(join(tmpdir(), 'flaremmerce-recovery-test-'));
  const run = (script: string, args: string[]) => spawnSync(process.execPath, [join(root, 'scripts', script), ...args], {
    cwd, encoding: 'utf8', env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
  });
  try {
    symlinkSync(join(root, 'node_modules'), join(cwd, 'node_modules'), 'dir');
    writeFileSync(join(cwd, 'wrangler.jsonc'), JSON.stringify({ name: 'recovery-test', compatibility_date: '2026-08-06',
      d1_databases: [{ binding: 'DB', database_name: 'recovery-test', database_id: '00000000-0000-0000-0000-000000000001' }] }));
    const sql = `PRAGMA defer_foreign_keys=TRUE;
CREATE TABLE session(id TEXT PRIMARY KEY, user_id TEXT REFERENCES user(id), token TEXT);
INSERT INTO session VALUES('s','u','quoted ''; semicolon;\nvalue');
CREATE TABLE user(id TEXT PRIMARY KEY);
INSERT INTO user VALUES('u');
CREATE TABLE ledger(note TEXT);
CREATE UNIQUE INDEX session_token ON session(token);
CREATE TRIGGER session_audit AFTER INSERT ON session BEGIN
 INSERT INTO ledger VALUES('first;entry');
 INSERT INTO ledger VALUES('second');
END;
`;
    const path = join(cwd, 'snapshot.sql');
    writeFileSync(path, sql, { mode: 0o600 });
    const hash = createHash('sha256').update(sql).digest('hex');
    const manifest = { version: 1, sha256: hash, bytes: Buffer.byteLength(sql), tables: { ledger: 0, session: 1, user: 1 } };
    writeFileSync(`${path}.manifest.json`, JSON.stringify(manifest));
    const target = join(cwd, 'restored');
    const restored = run('restore.mjs', [path, '--database', 'DB', '--persist-to', target]);
    expect(restored.status, restored.stderr).toBe(0);
    expect(JSON.parse(restored.stdout).tables).toEqual(manifest.tables);
    expect(readFileSync(path, 'utf8')).toBe(sql);
    const cli = join(root, 'node_modules/wrangler/bin/wrangler.js');
    const query = spawnSync(process.execPath, [cli, 'd1', 'execute', 'DB', '--local', '--persist-to', target,
      '--command', "INSERT INTO session VALUES('s2','u','other'); SELECT count(*) AS n FROM ledger; SELECT count(*) AS n FROM sqlite_schema WHERE type='index' AND name='session_token'; SELECT token FROM session WHERE id='s'; SELECT note FROM ledger ORDER BY rowid;", '--json'], { cwd, encoding: 'utf8', env: { ...process.env, WRANGLER_SEND_METRICS: 'false' } });
    expect(query.status, query.stderr).toBe(0);
    const results = JSON.parse(query.stdout);
    expect(results[1].results[0].n).toBe(2);
    expect(results[2].results[0].n).toBe(1);
    expect(results[3].results[0].token).toBe("quoted '; semicolon;\nvalue");
    expect(results[4].results).toEqual([{ note: 'first;entry' }, { note: 'second' }]);
    expect(run('restore.mjs', [path, '--database', 'DB', '--persist-to', target]).status).not.toBe(0);
    writeFileSync(`${path}.manifest.json`, JSON.stringify({ ...manifest, sha256: 'invalid' }));
    const rejected = join(cwd, 'rejected');
    expect(run('restore.mjs', [path, '--database', 'DB', '--persist-to', rejected]).status).not.toBe(0);
    expect(existsSync(rejected)).toBe(false);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
}, 120000);
