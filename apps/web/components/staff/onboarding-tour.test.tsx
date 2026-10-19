import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  effect: undefined as (() => (() => void) | undefined) | undefined,
  launch: { current: () => {} },
  userId: 'staff-1',
  support: false,
  active: false,
  drive: vi.fn(),
  setSteps: vi.fn(),
  destroy: vi.fn(),
}));

vi.mock('react', () => ({
  useEffect: (effect: typeof state.effect) => { state.effect = effect; },
  useRef: () => state.launch,
}));
vi.mock('driver.js', () => ({ driver: () => ({
  drive: state.drive,
  setSteps: state.setSteps,
  destroy: state.destroy,
  isActive: () => state.active,
}) }));
vi.mock('next/navigation', () => ({ usePathname: () => '/app' }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ lang: 'en' }) }));
vi.mock('@/lib/staff', () => ({ useStaff: () => ({
  me: { tenant: { id: 'restaurant-1' }, user: { id: state.userId }, impersonated_by: state.support },
  outlet: { id: 'outlet-1' }, outletId: 'outlet-1',
}) }));
vi.mock('@/components/ui/cn', () => ({ cn: (...values: string[]) => values.join(' ') }));

import { OnboardingTour } from './onboarding-tour';

describe('staff onboarding lifecycle', () => {
  let storage: Map<string, string>;
  let frame: (() => void) | undefined;
  let cleanup: (() => void) | undefined;
  const key = 'mezmitra.onboarding.v1:restaurant-1:staff-1';

  function mount() {
    OnboardingTour({});
    cleanup = state.effect?.();
  }

  beforeEach(() => {
    vi.clearAllMocks();
    storage = new Map();
    frame = undefined;
    state.userId = 'staff-1';
    state.support = false;
    state.active = false;
    state.drive.mockImplementation(() => { state.active = true; });
    state.destroy.mockImplementation(() => { state.active = false; });
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    });
    vi.stubGlobal('requestAnimationFrame', (callback: () => void) => { frame = callback; return 1; });
    vi.stubGlobal('cancelAnimationFrame', () => { frame = undefined; });
    vi.stubGlobal('window', { matchMedia: () => ({ matches: false }), addEventListener: vi.fn(), removeEventListener: vi.fn() });
    vi.stubGlobal('getComputedStyle', () => ({ visibility: 'visible' }));
    // Desktop control is hidden; the phone equivalent must be selected.
    vi.stubGlobal('document', { querySelectorAll: () => [
      { id: 'desktop', getClientRects: () => [] },
      { id: 'phone', getClientRects: () => [{}] },
    ] });
  });

  afterEach(() => {
    cleanup?.();
    vi.unstubAllGlobals();
  });

  it('shows once, persists on start, and still permits manual replay', () => {
    mount();
    frame?.();
    expect(state.drive).toHaveBeenCalledTimes(1);
    expect(storage.get(key)).toBe('shown');
    expect(state.setSteps.mock.calls[0]?.[0][0].element.id).toBe('phone');
    cleanup?.();
    mount();
    frame?.();
    expect(state.drive).toHaveBeenCalledTimes(1);
    state.launch.current();
    expect(state.drive).toHaveBeenCalledTimes(2);
  });

  it('does not consume the first visit during Strict Mode setup and cleanup', () => {
    mount();
    cleanup?.();
    frame?.();
    expect(storage.has(key)).toBe(false);
    mount();
    frame?.();
    expect(state.drive).toHaveBeenCalledTimes(1);
  });

  it('gives another account on the same device its own first visit', () => {
    storage.set(key, 'shown');
    state.userId = 'staff-2';
    mount();
    frame?.();
    expect(state.drive).toHaveBeenCalledTimes(1);
    expect(storage.get('mezmitra.onboarding.v1:restaurant-1:staff-2')).toBe('shown');
  });

  it('leaves the user flag untouched in support sessions', () => {
    state.support = true;
    mount();
    frame?.();
    expect(state.drive).not.toHaveBeenCalled();
    state.launch.current();
    expect(state.drive).toHaveBeenCalledTimes(1);
    expect(storage.has(key)).toBe(false);
  });

  it('allows manual replay when browser storage is blocked', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => { throw new Error('Storage blocked'); },
      setItem: () => { throw new Error('Storage blocked'); },
    });
    mount();
    frame?.();
    expect(state.drive).not.toHaveBeenCalled();
    expect(() => state.launch.current()).not.toThrow();
    expect(state.drive).toHaveBeenCalledTimes(1);
  });
});
