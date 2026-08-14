import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GitIgnore, isGitRepo, gitHead } from '../src/git.ts';
import { CaptureStore } from '../src/capture.ts';

async function tempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'threadtrail-gi-'));
}

async function write(rel: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(rel), { recursive: true });
  await fs.writeFile(rel, content, 'utf8');
}

/** Make `ws` look like a git repository (`.git` directory). */
async function gitRepo(ws: string): Promise<void> {
  await fs.mkdir(path.join(ws, '.git'), { recursive: true });
}

/** Load the ignore rules for a workspace with the given tree contents. */
async function load(ws: string, files: Record<string, string>): Promise<GitIgnore> {
  for (const [rel, content] of Object.entries(files)) {
    if (rel.endsWith('/')) {
      await fs.mkdir(path.join(ws, rel), { recursive: true });
    } else {
      await write(path.join(ws, rel), content);
    }
  }
  return GitIgnore.load(ws);
}

test('isGitRepo detects .git dirs and worktree .git files', async () => {
  const root = await tempDir();
  const ws = path.join(root, 'ws');
  await fs.mkdir(ws, { recursive: true });
  assert.equal(await isGitRepo(ws), false);

  await fs.mkdir(path.join(ws, '.git'), { recursive: true });
  assert.equal(await isGitRepo(ws), true);

  const sub = path.join(root, 'sub');
  await fs.mkdir(sub, { recursive: true });
  await fs.mkdir(path.join(root, 'gitdir'), { recursive: true });
  await fs.writeFile(path.join(sub, '.git'), 'gitdir: ' + path.join(root, 'gitdir') + '\n', 'utf8');
  assert.equal(await isGitRepo(sub), true);

  // a .git file without a gitdir line is not a repo
  const bad = path.join(root, 'bad');
  await fs.mkdir(bad, { recursive: true });
  await fs.writeFile(path.join(bad, '.git'), 'not a gitdir\n', 'utf8');
  assert.equal(await isGitRepo(bad), false);
  await fs.rm(root, { recursive: true, force: true });
});

test('a non-git workspace ignores nothing', async () => {
  const ws = await tempDir();
  await write(path.join(ws, '.gitignore'), '*.log\n');
  await write(path.join(ws, 'a.log'), 'x\n');
  const gi = await GitIgnore.load(ws);
  assert.equal(gi.isEmpty, true);
  assert.equal(gi.ignores('a.log'), false);
  await fs.rm(ws, { recursive: true, force: true });
});

test('basename patterns match at any depth; anchored patterns only at the root', async () => {
  const ws = await tempDir();
  await gitRepo(ws);
  const gi = await load(ws, {
    '.gitignore': '*.log\n/root-only.txt\n',
    'a.log': '',
    'sub/a.log': '',
    'root-only.txt': '',
    'sub/root-only.txt': '',
    'a.txt': '',
    'sub/deep/other.txt': '',
  });
  assert.equal(gi.ignores('a.log'), true);
  assert.equal(gi.ignores('sub/a.log'), true);
  assert.equal(gi.ignores('sub/deep/x.log'), true);
  assert.equal(gi.ignores('root-only.txt'), true);
  assert.equal(gi.ignores('sub/root-only.txt'), false);
  assert.equal(gi.ignores('a.txt'), false);
  assert.equal(gi.ignores('sub/deep/other.txt'), false);
  await fs.rm(ws, { recursive: true, force: true });
});

test('directory-only patterns ignore whole subtrees, at any depth when unanchored', async () => {
  const ws = await tempDir();
  await gitRepo(ws);
  const gi = await load(ws, {
    '.gitignore': 'build/\n/vendor/\n',
    'build/x/y.txt': '',
    'src/build/x.txt': '',
    'vendor/a.txt': '',
    'src/vendor/a.txt': '',
    'src/main.js': '',
  });
  assert.equal(gi.ignores('build/x/y.txt'), true);
  assert.equal(gi.ignores('src/build/x.txt'), true);
  assert.equal(gi.ignores('vendor/a.txt'), true);
  assert.equal(gi.ignores('src/vendor/a.txt'), false);
  assert.equal(gi.ignores('src/main.js'), false);
  await fs.rm(ws, { recursive: true, force: true });
});

test('negation re-includes files, but not files under an excluded directory', async () => {
  const ws = await tempDir();
  await gitRepo(ws);
  const gi = await load(ws, {
    '.gitignore': '*.log\n!keep.log\nbuild/\n!build/keep.txt\n',
    'a.log': '',
    'keep.log': '',
    'sub/keep.log': '',
    'build/x.txt': '',
    'build/keep.txt': '',
    'build/sub/keep.txt': '',
  });
  assert.equal(gi.ignores('a.log'), true);
  assert.equal(gi.ignores('keep.log'), false);
  assert.equal(gi.ignores('sub/keep.log'), false);
  assert.equal(gi.ignores('build/x.txt'), true);
  // `build/` excludes the directory itself, so `!build/keep.txt` cannot
  // re-include the file (git's documented rule); the anchored negation also
  // only re-includes that exact path, never deeper ones
  assert.equal(gi.ignores('build/keep.txt'), true);
  assert.equal(gi.ignores('build/sub/keep.txt'), true);
  await fs.rm(ws, { recursive: true, force: true });
});

test('a file inside an ignored dir can be re-included via dir/* + negation', async () => {
  const ws = await tempDir();
  await gitRepo(ws);
  const gi = await load(ws, {
    '.gitignore': 'build/*\n!build/keep.txt\n',
    'build/x.txt': '',
    'build/keep.txt': '',
    'build/sub/y.txt': '',
  });
  assert.equal(gi.ignores('build/x.txt'), true);
  assert.equal(gi.ignores('build/keep.txt'), false);
  assert.equal(gi.ignores('build/sub/y.txt'), true);
  await fs.rm(ws, { recursive: true, force: true });
});

test('re-including an excluded directory re-includes its contents', async () => {
  const ws = await tempDir();
  await gitRepo(ws);
  const gi = await load(ws, {
    '.gitignore': 'build/\n!build/\n',
    'build/x.txt': '',
    'build/sub/y.txt': '',
  });
  assert.equal(gi.ignores('build/x.txt'), false);
  assert.equal(gi.ignores('build/sub/y.txt'), false);
  await fs.rm(ws, { recursive: true, force: true });
});

test('deeper .gitignore files override shallower ones', async () => {
  const ws = await tempDir();
  await gitRepo(ws);
  const gi = await load(ws, {
    '.gitignore': '*.log\n',
    'a.log': '',
    'sub/.gitignore': '!keep.log\n',
    'sub/keep.log': '',
    'sub/other.log': '',
  });
  assert.equal(gi.ignores('a.log'), true);
  assert.equal(gi.ignores('sub/other.log'), true);
  assert.equal(gi.ignores('sub/keep.log'), false);
  await fs.rm(ws, { recursive: true, force: true });
});

test('$GIT_DIR/info/exclude is honored', async () => {
  const ws = await tempDir();
  await gitRepo(ws);
  const gi = await load(ws, {
    '.git/info/exclude': '*.tmp\n',
    'a.tmp': '',
    'a.txt': '',
    'sub/a.tmp': '',
  });
  assert.equal(gi.ignores('a.tmp'), true);
  assert.equal(gi.ignores('sub/a.tmp'), true);
  assert.equal(gi.ignores('a.txt'), false);
  await fs.rm(ws, { recursive: true, force: true });
});

test('glob forms: ?, **/ , /** and /**/ ', async () => {
  const ws = await tempDir();
  await gitRepo(ws);
  const gi = await load(ws, {
    '.gitignore': 'file?.txt\n**/generated/\nassets/**\nlogs/**/debug.log\n',
    'file1.txt': '',
    'file12.txt': '',
    'sub/generated/x.txt': '',
    'a/b/c/generated/y.txt': '',
    'assets/x.txt': '',
    'assets/deep/y.txt': '',
    'logs/debug.log': '',
    'logs/2024/debug.log': '',
    'logs/info.log': '',
  });
  assert.equal(gi.ignores('file1.txt'), true);
  assert.equal(gi.ignores('file12.txt'), false);
  assert.equal(gi.ignores('sub/generated/x.txt'), true);
  assert.equal(gi.ignores('a/b/c/generated/y.txt'), true);
  assert.equal(gi.ignores('assets/x.txt'), true);
  assert.equal(gi.ignores('assets/deep/y.txt'), true);
  assert.equal(gi.ignores('logs/debug.log'), true);
  assert.equal(gi.ignores('logs/2024/debug.log'), true);
  assert.equal(gi.ignores('logs/info.log'), false);
  await fs.rm(ws, { recursive: true, force: true });
});

test('comments and blank lines are skipped', async () => {
  const ws = await tempDir();
  await gitRepo(ws);
  const gi = await load(ws, {
    '.gitignore': '# comment\n\n  \n*.log\n',
    'a.log': '',
    'a.txt': '',
  });
  assert.equal(gi.ignores('a.log'), true);
  assert.equal(gi.ignores('a.txt'), false);
  await fs.rm(ws, { recursive: true, force: true });
});

test('capture does not trace git-ignored files, but does trace re-included ones', async () => {
  const root = await tempDir();
  const ws = path.join(root, 'ws');
  await fs.mkdir(ws, { recursive: true });
  await gitRepo(ws);
  await write(path.join(ws, '.gitignore'), '*.log\n!keep.log\n');
  await write(path.join(ws, 'a.txt'), 'one\n');
  await write(path.join(ws, 'b.log'), 'log one\n');
  await write(path.join(ws, 'keep.log'), 'keep one\n');

  const store = new CaptureStore({ root: path.join(root, 'data') });
  await store.init();
  const sc = store.getOrCreate('sess-1', ws);

  // baseline scan establishes the (filtered) manifest
  await sc.scan({ trigger: 'turn/start', atSeq: 1, turn: null, userMessageSeq: null, assistantSeqs: [] });

  // edits: tracked file, ignored file, re-included file
  await write(path.join(ws, 'a.txt'), 'one\ntwo\n');
  await write(path.join(ws, 'b.log'), 'log two\n');
  await write(path.join(ws, 'keep.log'), 'keep two\n');
  const op = await sc.scan({ trigger: 'turn/end', atSeq: 5, turn: 1, userMessageSeq: 3, assistantSeqs: [4] });
  assert.ok(op);
  const paths = op.files.map((f) => f.path).sort();
  assert.deepEqual(paths, ['a.txt', 'keep.log']);

  // deleting an ignored file produces no op
  await fs.rm(path.join(ws, 'b.log'));
  await write(path.join(ws, 'a.txt'), 'one\ntwo\nthree\n');
  const op2 = await sc.scan({ trigger: 'turn/end', atSeq: 9, turn: 2, userMessageSeq: 7, assistantSeqs: [8] });
  assert.ok(op2);
  assert.deepEqual(op2.files.map((f) => f.path), ['a.txt']);

  // worktree browser hides git-ignored files too (the .gitignore file itself
  // stays visible — it is a real workspace file, not an ignored one)
  const tree = await sc.tree();
  assert.ok(tree);
  assert.deepEqual(tree.files.map((f) => f.path).sort(), ['.gitignore', 'a.txt', 'keep.log']);
  await fs.rm(root, { recursive: true, force: true });
});

test('a file becoming git-ignored stops being traced and is reported removed', async () => {
  const root = await tempDir();
  const ws = path.join(root, 'ws');
  await fs.mkdir(ws, { recursive: true });
  await gitRepo(ws);
  await write(path.join(ws, 'secret.env'), 'TOKEN=1\n');

  const store = new CaptureStore({ root: path.join(root, 'data') });
  await store.init();
  const sc = store.getOrCreate('sess-1', ws);
  await sc.scan({ trigger: 'turn/start', atSeq: 1, turn: null, userMessageSeq: null, assistantSeqs: [] });
  await write(path.join(ws, 'secret.env'), 'TOKEN=2\n');
  await sc.scan({ trigger: 'turn/end', atSeq: 5, turn: 1, userMessageSeq: 3, assistantSeqs: [4] });
  assert.equal(sc.ops.length, 1);

  // .gitignore now excludes secret.env -> the next scan drops it from the
  // trace (the .gitignore file itself is captured, since it was just edited)
  await write(path.join(ws, '.gitignore'), 'secret.env\n');
  const op = await sc.scan({ trigger: 'turn/start', atSeq: 10, turn: null, userMessageSeq: 8, assistantSeqs: [] });
  assert.ok(op);
  assert.deepEqual(op.files.map((f) => f.path), ['.gitignore', 'secret.env']);
  assert.equal(op.files.find((f) => f.path === 'secret.env')!.deleted, true);

  // edits to it no longer produce ops
  await write(path.join(ws, 'secret.env'), 'TOKEN=3\n');
  const op2 = await sc.scan({ trigger: 'turn/end', atSeq: 14, turn: 2, userMessageSeq: 12, assistantSeqs: [13] });
  assert.equal(op2, null);
  await fs.rm(root, { recursive: true, force: true });
});

test('gitHead still resolves after the gitdir refactor', async () => {
  const root = await tempDir();
  const ws = path.join(root, 'ws');
  await fs.mkdir(path.join(ws, '.git', 'refs', 'heads'), { recursive: true });
  const sha = 'd'.repeat(40);
  await fs.writeFile(path.join(ws, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8');
  await fs.writeFile(path.join(ws, '.git', 'refs', 'heads', 'main'), sha + '\n', 'utf8');
  assert.equal(await gitHead(ws), sha);
  await fs.rm(root, { recursive: true, force: true });
});
