import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { helpFor, installHoverHelp } from './hover-help';

describe('contextual help during normal use', () => {
  let cleanup: () => void;
  let dom: JSDOM;
  const over = (element: Element) => element.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' }));
  const tip = () => document.querySelector('[role="tooltip"]');

  beforeEach(() => {
    vi.useFakeTimers();
    dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true });
    for (const name of ['window', 'document', 'Element', 'HTMLElement', 'Node', 'PointerEvent', 'FocusEvent', 'KeyboardEvent', 'DOMRect', 'MutationObserver'] as const) {
      vi.stubGlobal(name, dom.window[name]);
    }
    document.body.innerHTML = '<a href="/app/inbox" aria-describedby="existing">Orders</a><button>Save</button>';
    vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue({ 0: new DOMRect(), length: 1, item: () => new DOMRect(), [Symbol.iterator]: function* () { yield new DOMRect(); } } as DOMRectList);
    cleanup = installHoverHelp(false);
  });
  afterEach(() => {
    cleanup();
    dom.window.close();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('waits four seconds and describes how to use the hovered control', () => {
    over(document.querySelector('a')!);
    vi.advanceTimersByTime(3999);
    expect(tip()).toBeNull();
    vi.advanceTimersByTime(1);
    expect(tip()?.textContent).toContain('Review incoming orders');
    expect(document.querySelector('a')?.getAttribute('aria-describedby')).toContain('existing mezmitra-context-help');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(tip()).toBeNull();
    expect(document.querySelector('a')?.getAttribute('aria-describedby')).toBe('existing');
  });

  it('cancels on leaving a control and restarts the wait on another', () => {
    const link = document.querySelector('a')!;
    over(link);
    vi.advanceTimersByTime(3000);
    link.dispatchEvent(new PointerEvent('pointerout', { bubbles: true }));
    over(document.querySelector('button')!);
    vi.advanceTimersByTime(1000);
    expect(tip()).toBeNull();
    vi.advanceTimersByTime(3000);
    expect(tip()?.textContent).toContain('Save');
  });

  it('does not compete with the onboarding tour', async () => {
    over(document.querySelector('a')!);
    vi.advanceTimersByTime(4000);
    document.body.classList.add('driver-active');
    await Promise.resolve();
    expect(tip()).toBeNull();
    over(document.querySelector('button')!);
    vi.advanceTimersByTime(4000);
    expect(tip()).toBeNull();
  });

  it('supports keyboard focus and dismisses on interaction', () => {
    document.querySelector('button')!.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    vi.advanceTimersByTime(4000);
    expect(tip()).not.toBeNull();
    document.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    expect(tip()).toBeNull();
  });

  it('lets the pointer move onto the help bubble to read it', () => {
    const link = document.querySelector('a')!;
    over(link);
    vi.advanceTimersByTime(4000);
    link.dispatchEvent(new PointerEvent('pointerout', { bubbles: true }));
    over(tip()!);
    vi.advanceTimersByTime(200);
    expect(tip()).not.toBeNull();
    tip()!.dispatchEvent(new PointerEvent('pointerout', { bubbles: true }));
    vi.advanceTimersByTime(150);
    expect(tip()).toBeNull();
  });

  it('ignores touch and removes pending tips on cleanup', () => {
    document.querySelector('a')!.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'touch' }));
    vi.advanceTimersByTime(4000);
    expect(tip()).toBeNull();
    over(document.querySelector('a')!);
    cleanup();
    vi.advanceTimersByTime(4000);
    expect(tip()).toBeNull();
  });

  it('explains fields without including sensitive values and escapes labels', () => {
    document.body.innerHTML = '<label for="password">Password</label><input id="password" type="password" value="secret">';
    expect(helpFor(document.querySelector('input')!, false)).toEqual({ title: 'Password', description: expect.stringContaining('Enter or edit') });
    const button = document.createElement('button');
    button.textContent = '<img src=x onerror=alert(1)>';
    document.body.append(button);
    over(button);
    vi.advanceTimersByTime(4000);
    expect(tip()?.querySelector('img')).toBeNull();
  });
});
