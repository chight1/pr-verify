import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildRepositoryMap, capUtf8, dropNoise, extractStepLog, isNoise, Scrubber, tail } from '../src/context.js';
import { parseDiff } from '../src/diff.js';

describe('dropNoise', () => {
  const section = (p: string) => `diff --git a/${p} b/${p}\nindex 1..2 100644\n--- a/${p}\n+++ b/${p}\n@@ -1,1 +1,1 @@\n-a\n+b`;

  it('drops lockfiles, minified files, source maps and generated files, and names them', () => {
    const text = ['src/a.ts', 'package-lock.json', 'web/app.min.js', 'web/app.js.map', 'api/client.ts', 'src/b.ts'].map(section).join('\n') + '\n';
    const diff = dropNoise(text, (p) => p === 'api/client.ts');
    expect(parseDiff(diff.text).map((f) => [f.path, f.added, f.removed])).toEqual([
      ['src/a.ts', 1, 1],
      ['src/b.ts', 1, 1],
    ]);
    expect(diff.omitted).toEqual(['package-lock.json', 'web/app.min.js', 'web/app.js.map', 'api/client.ts']);
  });

  it('keeps dependency manifests, which a reviewer should see', () => {
    for (const p of ['package.json', 'pyproject.toml', 'go.mod', 'src/package-lock.ts']) expect(isNoise(p), p).toBe(false);
    for (const p of ['sub/yarn.lock', 'go.sum', 'uv.lock', 'dist/x.min.css']) expect(isNoise(p), p).toBe(true);
  });

  it('leaves an empty diff empty', () => {
    expect(dropNoise('')).toEqual({ text: '', omitted: [] });
  });
});

const LOG = readFileSync(path.join(__dirname, 'fixtures', 'gate-job.log'), 'utf8');

describe('buildRepositoryMap', () => {
  it('sorts and keeps everything under the cap', () => {
    const map = buildRepositoryMap(['src/b.ts', 'src/a.ts', 'README.md']);
    expect(map.text).toBe('README.md\nsrc/a.ts\nsrc/b.ts');
    expect(map).toMatchObject({ fileCount: 3, truncated: false });
  });

  it('truncates with a count once the cap is hit', () => {
    const files = Array.from({ length: 50 }, (_, i) => `src/file-${String(i).padStart(2, '0')}.ts`);
    const map = buildRepositoryMap(files, 200);
    expect(map.truncated).toBe(true);
    expect(map.text.split('\n').at(-1)).toMatch(/^\.\.\. \d+ more files omitted$/);
    expect(Buffer.byteLength(map.text)).toBeLessThan(260);
  });
});

describe('capUtf8', () => {
  it('returns short input unchanged', () => {
    expect(capUtf8(Buffer.from('hello'), 8192)).toEqual({ text: 'hello', bytes: 5, truncated: false });
  });

  it('cuts on a character boundary', () => {
    const text = 'ab€cd'; // € is 3 bytes: a(1) b(1) €(3) = 5
    const capped = capUtf8(Buffer.from(text), 4);
    expect(capped.truncated).toBe(true);
    expect(capped.text).toBe('ab');
    expect(capped.bytes).toBe(2);
  });
});

describe('Scrubber', () => {
  const scrubber = new Scrubber(['supersecretvalue', undefined, 'short']);

  it('replaces exact secret values and well-known token shapes', () => {
    const text = 'key=supersecretvalue token=ghp_abcdefghijklmnopqrstuvwxyz0123 anthropic=sk-ant-api03-abcdefghijklmnopqrstuvwxyz';
    const out = scrubber.scrub(text);
    expect(out).not.toContain('supersecretvalue');
    expect(out).not.toContain('ghp_');
    expect(out).not.toContain('sk-ant-');
    expect(out).toBe('key=[redacted] token=[redacted] anthropic=[redacted]');
  });

  it('ignores secrets too short to be meaningful and leaves other text alone', () => {
    expect(scrubber.scrub('a short walk')).toBe('a short walk');
  });

  it('redacts private key blocks', () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nabc\ndef\n-----END RSA PRIVATE KEY-----';
    expect(scrubber.scrub(`before ${pem} after`)).toBe('before [redacted] after');
  });
});

describe('extractStepLog', () => {
  it('returns only the failing step section, stripped of timestamps', () => {
    const section = extractStepLog(LOG, 'test');
    expect(section.startsWith('##[group]Run npm test')).toBe(true);
    expect(section).toContain('FAIL test/order.test.ts');
    expect(section).toContain('##[error]Process completed with exit code 1.');
    expect(section).not.toContain('npm ci');
    expect(section).not.toContain('Post job cleanup');
    expect(section).not.toMatch(/^\d{4}-\d{2}-\d{2}T/m);
  });

  it('falls back to the tail of the log when no section can be found', () => {
    const plain = 'line one\nline two\n##[error]boom';
    expect(extractStepLog(plain, 'anything')).toBe(plain);
  });
});

describe('tail', () => {
  it('keeps the last whole lines within the byte limit', () => {
    const out = tail('aaaa\nbbbb\ncccc\ndddd', 9);
    expect(out).toBe('[... 10 bytes trimmed]\ndddd');
  });
});
