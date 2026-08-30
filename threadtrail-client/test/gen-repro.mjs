// Build a standalone repro page for the ThreadTrail overlay CSS:
// real CSS from src/css.ts + DOM identical to diffview.tsx output.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cssSrc = readFileSync(path.join(root, 'src', 'css.ts'), 'utf8');
const css = cssSrc.match(/export const CSS = `([\s\S]*?)`;/)[1];

function diffLines(n) {
  let out = '';
  for (let i = 0; i < n; i++) {
    const t = i % 3 === 0 ? '+' : i % 3 === 1 ? '-' : ' ';
    out += `<div class="ddb-line ddb-line-${t === ' ' ? 'x' : t}"><span class="ddb-line-mark">${t}</span><span class="ddb-line-text">line ${i} const value${i} = computeSomething(${i}, "payload"); // some code content here</span></div>`;
  }
  return out;
}

function fileCard(name, lines) {
  return `<div class="ddb-opfile">
  <div class="ddb-opfile-head ddb-opfile-toggle"><span class="ddb-opfile-path">${name}</span><span class="ddb-opfile-stats">+${lines}/-0</span></div>
  <div class="ddb-diff"><div class="ddb-hunk-head">@@ -1,${lines} +1,${lines} @@</div>${diffLines(lines)}</div>
</div>`;
}

const cards = [
  fileCard('src/huge-file.ts', 5000),
  fileCard('src/small-a.ts', 15),
  fileCard('src/small-b.ts', 15),
  fileCard('src/small-c.ts', 15),
  fileCard('src/small-d.ts', 15),
  fileCard('src/small-e.ts', 15),
];

const html = `<!doctype html>
<html><head><meta charset="utf-8"><style>
body{margin:0;background:#1e1e1e;font-family:sans-serif}
${css}
</style></head>
<body>
<div class="ddb-overlay">
  <div class="ddb-overlay-head"><span class="ddb-overlay-title">ThreadTrail repro</span></div>
  <div class="ddb-overlay-body">
    <div class="ddb-worksplit">
      <div class="ddb-worksplit-tree"><div class="ddb-note">records tree</div></div>
      <div class="ddb-worksplit-viewer" id="viewer">
        <div class="ddb-diff-summary">6 files · +5045 -0</div>
        ${cards.join('\n')}
      </div>
    </div>
  </div>
</div>
</body></html>`;

writeFileSync(path.join(root, 'test', 'overlay-repro.html'), html);
console.log('wrote test/overlay-repro.html,', html.length, 'bytes');
