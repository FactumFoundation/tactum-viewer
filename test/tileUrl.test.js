import { describe, it, expect } from 'vitest';
import { tileUrl } from '../src/tileUrl.js';

describe('tileUrl', () => {
  const node = { level: 3, col: 2, row: 5 };

  it('builds a channel path under the base url', () => {
    expect(tileUrl('../moss/', 'height', node))
      .toBe('../moss/height/3/2/5.png');
  });

  it('works for the albedo channel and a different base', () => {
    expect(tileUrl('../../other-dataset/', 'albedo', node))
      .toBe('../../other-dataset/albedo/3/2/5.png');
  });
});
