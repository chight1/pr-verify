import { describe, expect, it } from 'vitest';
import { renderPrecision, tallyPrecision } from '../src/precision.js';
import { findingMarker } from '../src/review.js';
import type { PriorFinding } from '../src/types.js';

const finding = (category: PriorFinding['category'], verified: boolean, line: number): PriorFinding => ({
  category,
  verified,
  file: 'src/a.ts',
  line,
  title: 'Something',
  headSha: 'abc',
});

const comment = (f: PriorFinding, thumbsDown = 0) => ({ body: `Text.\n\n${findingMarker(f)}`, thumbsDown });

describe('tallyPrecision', () => {
  it('counts findings and thumbs-downs per category, verified and unverified apart', () => {
    const rows = tallyPrecision([
      comment(finding('bug', true, 1)),
      comment(finding('bug', true, 2), 1),
      comment(finding('bug', false, 3), 2),
      comment(finding('security', true, 4)),
      { body: 'A person replying, no marker.', thumbsDown: 3 },
    ]);
    expect(rows).toEqual([
      { category: 'bug', verified: true, posted: 2, markedWrong: 1 },
      { category: 'bug', verified: false, posted: 1, markedWrong: 1 },
      { category: 'security', verified: true, posted: 1, markedWrong: 0 },
    ]);
    expect(renderPrecision(rows).split('\n')[1]).toMatch(/^bug\s+verified\s+2\s+1\s+50%$/);
  });

  it('says so when nothing has been posted', () => {
    expect(renderPrecision(tallyPrecision([]))).toBe('No inline findings posted yet.');
  });
});
