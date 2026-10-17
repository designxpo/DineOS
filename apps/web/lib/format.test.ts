import { describe, expect, it } from 'vitest';
import { duration } from './format';

describe('duration', () => {
  it('says spans of time the way staff would', () => {
    expect(duration(0)).toBe('0 min');
    expect(duration(45)).toBe('45 min');
    expect(duration(60)).toBe('1 h');
    expect(duration(125)).toBe('2 h 5 min');
    expect(duration(1521)).toBe('25 h');
  });
});
