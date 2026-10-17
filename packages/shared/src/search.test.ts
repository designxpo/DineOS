import { describe, expect, it } from 'vitest';
import { dishScore, searchDishes } from './search';

const menu = [
  { id: '1', name: 'Paneer Tikka' },
  { id: '2', name: 'Paneer Tikka Masala', short_code: 'PTM' },
  { id: '3', name: 'Cold Coffee', short_code: 'CC' },
  { id: '4', name: 'Chicken Curry' },
  { id: '5', name: 'Masala Chai', short_code: 'T1' },
  { id: '6', name: 'Tandoori Paneer' },
];
const names = (q: string, popular: string[] = []) => searchDishes(menu, q, popular).map((d) => d.name);

describe('finding a dish', () => {
  it('by the first letters of its words', () => {
    expect(names('pt')).toEqual(['Paneer Tikka', 'Paneer Tikka Masala']);
    expect(names('ptm')[0]).toBe('Paneer Tikka Masala');
  });

  it("by the outlet's short code, ahead of everything else", () => {
    expect(names('t1')).toEqual(['Masala Chai']);
    expect(names('cc')[0]).toBe('Cold Coffee');
    expect(dishScore('CC', menu[2]!)).toBe(100);
  });

  it('by the start of each typed word, in order', () => {
    expect(names('pan tik')).toEqual(['Paneer Tikka', 'Paneer Tikka Masala']);
    expect(names('tik pan')).toEqual([]);
  });

  it('anywhere in the name, as before', () => {
    expect(names('paneer')).toEqual(['Paneer Tikka', 'Paneer Tikka Masala', 'Tandoori Paneer']);
    expect(names('neer')).toEqual(['Paneer Tikka', 'Paneer Tikka Masala', 'Tandoori Paneer']);
  });

  it("puts what the outlet sells most first among equal matches", () => {
    // "c" starts both Cold Coffee and Chicken Curry; the best seller comes first.
    expect(names('c', ['4', '3']).slice(0, 2)).toEqual(['Chicken Curry', 'Cold Coffee']);
  });

  it('finds nothing for nothing', () => {
    expect(names('  ')).toEqual([]);
    expect(names('xyz')).toEqual([]);
  });
});
