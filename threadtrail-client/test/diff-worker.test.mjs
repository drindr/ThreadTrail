import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseDiffResponse } from '../src/diff-worker.ts';

const payload = JSON.stringify({
  files: [
    {
      path: 'src/huge.ts',
      oldPath: null,
      status: 'modified',
      binary: false,
      added: 3,
      removed: 0,
      hunks: [
        {
          oldStart: 1,
          oldLines: 0,
          newStart: 1,
          newLines: 3,
          header: '',
          lines: [
            { t: '+', text: 'const a = 1;' },
            { t: '+', text: 'const b = 2;' },
            { t: '+', text: 'export { a, b };' },
          ],
        },
      ],
    },
  ],
  truncated: false,
});

describe('diff worker parsing', () => {
  it('parses and hashes responses without blocking the caller', async () => {
    const parsed = await parseDiffResponse(payload);
    assert.equal(parsed.diff.files.length, 1);
    assert.equal(typeof parsed.hash, 'number');
    assert.notEqual(parsed.hash, 0);
  });

  it('rejects malformed payloads without caching them', async () => {
    await assert.rejects(() => parseDiffResponse('{broken'), SyntaxError);
  });
});
