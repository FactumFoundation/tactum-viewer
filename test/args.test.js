import { describe, it, expect } from 'vitest';
import { parseArgs } from '../scripts/lib/args.js';

describe('parseArgs', () => {
  it('returns defaults when no args are given', () => {
    expect(parseArgs([], { src: 'data/x.tif', out: 'public/x' }))
      .toEqual({ src: 'data/x.tif', out: 'public/x' });
  });

  it('overrides with --key value', () => {
    expect(parseArgs(['--src', '/tmp/y.tif'], { src: 'data/x.tif', out: 'public/x' }))
      .toEqual({ src: '/tmp/y.tif', out: 'public/x' });
  });

  it('overrides with --key=value', () => {
    expect(parseArgs(['--out=/tmp/out'], { src: 'data/x.tif', out: 'public/x' }))
      .toEqual({ src: 'data/x.tif', out: '/tmp/out' });
  });

  it('preserves the default when a flag has no value (trailing flag)', () => {
    expect(parseArgs(['--src'], { src: 'data/x.tif', out: 'public/x' }))
      .toEqual({ src: 'data/x.tif', out: 'public/x' });
  });

  it('does not treat a following flag as a value', () => {
    expect(parseArgs(['--src', '--out', '/tmp/out'], { src: 'data/x.tif', out: 'public/x' }))
      .toEqual({ src: 'data/x.tif', out: '/tmp/out' });
  });
});
