import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { WORKTREE_ID, collectRecords, diffRecords, findGitSubdirs, parsePatch } from '../src/repo.ts';

async function tempRepo(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'threadtrail-repo-'));
  const git = (args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  git(['init']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test']);
  return dir;
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

async function write(dir: string, rel: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
  await fs.writeFile(path.join(dir, rel), content, 'utf8');
}

test('parsePatch parses modified/added/deleted/renamed/binary entries', () => {
  const patch = [
    'diff --git a/mod.ts b/mod.ts',
    'index 111..222 100644',
    '--- a/mod.ts',
    '+++ b/mod.ts',
    '@@ -1,3 +1,3 @@ function f',
    ' ctx',
    '-old',
    '+new',
    ' tail',
    'diff --git a/new.ts b/new.ts',
    'new file mode 100644',
    'index 000..333',
    '--- /dev/null',
    '+++ b/new.ts',
    '@@ -0,0 +1,2 @@',
    '+a',
    '+b',
    'diff --git a/gone.ts b/gone.ts',
    'deleted file mode 100644',
    'index 444..000',
    '--- a/gone.ts',
    '+++ /dev/null',
    '@@ -1 +0,0 @@',
    '-bye',
    'diff --git a/old name.ts b/new name.ts',
    'similarity index 90%',
    'rename from old name.ts',
    'rename to new name.ts',
    'diff --git a/img.png b/img.png',
    'index 555..666 100644',
    'Binary files a/img.png and b/img.png differ',
    '',
  ].join('\n');

  const files = parsePatch(patch);
  assert.equal(files.length, 5);

  const [mod, added, gone, renamed, bin] = files;
  assert.equal(mod.status, 'modified');
  assert.equal(mod.path, 'mod.ts');
  assert.deepEqual([mod.added, mod.removed], [1, 1]);
  assert.equal(mod.hunks.length, 1);
  assert.equal(mod.hunks[0].header, 'function f');
  assert.deepEqual(
    mod.hunks[0].lines.map((l) => l.t + l.text),
    [' ctx', '-old', '+new', ' tail'],
  );

  assert.equal(added.status, 'added');
  assert.equal(added.added, 2);
  assert.equal(added.oldPath, null);

  assert.equal(gone.status, 'deleted');
  assert.equal(gone.path, 'gone.ts'); // falls back to the old path
  assert.equal(gone.oldPath, 'gone.ts');
  assert.equal(gone.removed, 1);

  assert.equal(renamed.status, 'renamed');
  assert.equal(renamed.oldPath, 'old name.ts');
  assert.equal(renamed.path, 'new name.ts');

  assert.equal(bin.binary, true);
  assert.equal(bin.hunks.length, 0);
});

test('collectRecords lists the worktree record plus commits, newest first', async () => {
  const dir = await tempRepo();
  await write(dir, 'a.txt', 'one\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-m', 'first']);
  await write(dir, 'a.txt', 'one\ntwo\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-m', 'second']);

  const res = await collectRecords(dir);
  assert.equal(res.isRepo, true);
  assert.equal(res.gitAvailable, true);
  assert.ok(res.head);
  assert.deepEqual(res.worktree, { changed: 0, untracked: 0 });
  assert.equal(res.records[0].id, WORKTREE_ID);
  assert.equal(res.records.length, 4); // worktree + 2 commits + empty tree
  assert.equal(res.records[1].subject, 'second');
  assert.equal(res.records[2].subject, 'first');
  assert.equal(res.records[1].id, res.head);
  // Parent linkage: the newest commit's parent is the root, whose parent is null.
  assert.equal(res.records[1].parent, res.records[2].id);
  assert.equal(res.records[2].parent, null);
  assert.deepEqual(res.records[3], { id: 'empty', kind: 'empty' });

  // An uncommitted change shows up in the worktree status counts.
  await write(dir, 'a.txt', 'one\ntwo\nthree\n');
  await write(dir, 'untracked.txt', 'hello\n');
  const res2 = await collectRecords(dir);
  assert.deepEqual(res2.worktree, { changed: 1, untracked: 1 });
});

test('diffRecords compares two commits', async () => {
  const dir = await tempRepo();
  await write(dir, 'a.txt', 'one\ntwo\nthree\n');
  await write(dir, 'b.txt', 'keep\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-m', 'first']);
  const c1 = git(dir, ['rev-parse', 'HEAD']).trim();

  await write(dir, 'a.txt', 'one\nCHANGED\nthree\n');
  await fs.rm(path.join(dir, 'b.txt'));
  await write(dir, 'c.txt', 'brand new\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-m', 'second']);
  const c2 = git(dir, ['rev-parse', 'HEAD']).trim();

  const diff = await diffRecords(dir, c1, c2);
  assert.equal(diff.truncated, false);
  const byPath = new Map(diff.files.map((f) => [f.path, f]));
  assert.equal(byPath.get('a.txt')?.status, 'modified');
  assert.equal(byPath.get('a.txt')?.added, 1);
  assert.equal(byPath.get('a.txt')?.removed, 1);
  assert.equal(byPath.get('b.txt')?.status, 'deleted');
  assert.equal(byPath.get('c.txt')?.status, 'added');

  // Same record on both sides: empty diff.
  const empty = await diffRecords(dir, c1, c1);
  assert.deepEqual(empty.files, []);
});

test('diffRecords treats the worktree as a record, both directions', async () => {
  const dir = await tempRepo();
  await write(dir, 'a.txt', 'one\ntwo\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-m', 'first']);
  const c1 = git(dir, ['rev-parse', 'HEAD']).trim();

  // Uncommitted: one tracked edit + one untracked file.
  await write(dir, 'a.txt', 'one\ntwo\nthree\n');
  await write(dir, 'untracked.txt', 'fresh\nfile\n');

  const fwd = await diffRecords(dir, c1, WORKTREE_ID);
  const a = fwd.files.find((f) => f.path === 'a.txt');
  assert.ok(a);
  assert.equal(a.status, 'modified');
  assert.deepEqual([a.added, a.removed], [1, 0]);
  const un = fwd.files.find((f) => f.path === 'untracked.txt');
  assert.ok(un, 'untracked file must appear as an addition');
  assert.equal(un.status, 'added');
  assert.equal(un.added, 2);
  assert.deepEqual(un.hunks[0].lines.map((l) => l.t), ['+', '+']);

  // Inverted: worktree -> commit reports the same changes reversed.
  const rev = await diffRecords(dir, WORKTREE_ID, c1);
  const ra = rev.files.find((f) => f.path === 'a.txt');
  assert.ok(ra);
  assert.deepEqual([ra.added, ra.removed], [0, 1]);
  assert.deepEqual(
    ra.hunks[0].lines.filter((l) => l.t !== ' ').map((l) => l.t + l.text),
    ['-three'],
  );
  const run = rev.files.find((f) => f.path === 'untracked.txt');
  assert.ok(run);
  assert.equal(run.status, 'deleted');
  assert.deepEqual(run.hunks[0].lines.map((l) => l.t), ['-', '-']);
});

test('diffRecords supports the empty-tree record (viewing the root commit)', async () => {
  const dir = await tempRepo();
  await write(dir, 'a.txt', 'one\ntwo\n');
  await write(dir, 'b.txt', 'keep\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-m', 'root commit']);
  const root = git(dir, ['rev-parse', 'HEAD']).trim();

  const diff = await diffRecords(dir, 'empty', root);
  assert.equal(diff.files.length, 2);
  for (const f of diff.files) {
    assert.equal(f.status, 'added');
    assert.equal(f.removed, 0);
  }
  assert.equal(diff.files.find((f) => f.path === 'a.txt')?.added, 2);

  // Worktree against the empty tree: everything present is an addition.
  await write(dir, 'untracked.txt', 'fresh\n');
  const full = await diffRecords(dir, 'empty', WORKTREE_ID);
  assert.ok(full.files.find((f) => f.path === 'untracked.txt'));
  assert.ok(full.files.every((f) => f.status === 'added'));
});

test('diffRecords rejects invalid record ids', async () => {
  const dir = await tempRepo();
  await assert.rejects(() => diffRecords(dir, '../../etc', WORKTREE_ID), /invalid record id/);
});

test('findGitSubdirs finds nested repositories, skipping noise directories', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'threadtrail-sub-'));
  const mk = async (rel: string, isRepo: boolean) => {
    await fs.mkdir(path.join(dir, rel), { recursive: true });
    if (isRepo) git(dir, ['init', rel]);
  };
  await mk('proj', true);
  await mk('libs/deep/lib', true); // depth 3
  await mk('node_modules/dep', true); // skipped
  await mk('.hidden/repo', true); // skipped
  await mk('plain/dir', false);

  const found = await findGitSubdirs(dir);
  assert.ok(found.includes('proj'));
  assert.ok(found.includes('libs/deep/lib'));
  assert.ok(!found.some((f) => f.includes('node_modules') || f.includes('.hidden')));
});

test('collectRecords lists nested repositories (submodules) even when the root is a repo', async () => {
  const dir = await tempRepo();
  await write(dir, 'a.txt', 'one\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-m', 'first']);
  git(dir, ['init', 'vendor/lib']); // nested repo (stands in for a submodule)

  const res = await collectRecords(dir);
  assert.equal(res.isRepo, true);
  assert.ok(res.records.length >= 2, 'root repo records present');
  assert.deepEqual(res.candidates, ['vendor/lib']);
});

test('collectRecords lists git subfolder candidates outside a repository', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'threadtrail-nogit-'));
  git(dir, ['init', 'sub']);
  const res = await collectRecords(dir);
  assert.equal(res.isRepo, false);
  assert.deepEqual(res.records, []);
  assert.deepEqual(res.candidates, ['sub']);
});
