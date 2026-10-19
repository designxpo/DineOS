import { JSDOM } from 'jsdom';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AnimatedReceiptPrinter, RECEIPT_ANIMATION_DURATION_MS } from './animated-receipt-printer';

let dom: JSDOM;
let root: Root;
let container: HTMLDivElement;
let reduced = false;
const disconnect = vi.fn();
beforeEach(() => {
  dom = new JSDOM('<!doctype html><html><body></body></html>');
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.window.document);
  vi.stubGlobal('HTMLDialogElement', dom.window.HTMLDialogElement);
  vi.stubGlobal('Event', dom.window.Event);
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect = disconnect; });
  window.matchMedia = vi.fn().mockImplementation(() => ({ matches: reduced, addEventListener() {}, removeEventListener() {} }));
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  dom.window.close();
  vi.unstubAllGlobals();
  reduced = false;
});
it('keeps supplied receipt data visible after the animation finishes', () => {
  const dismiss = vi.fn();
  act(() => root.render(<AnimatedReceiptPrinter onDismiss={dismiss}>Invoice 42 · Rs. 409.50</AnimatedReceiptPrinter>));
  expect(document.querySelector('section')?.textContent).toContain('Invoice 42 · Rs. 409.50');
  act(() => vi.advanceTimersByTime(RECEIPT_ANIMATION_DURATION_MS - 1));
  expect(dismiss).not.toHaveBeenCalled();
  act(() => vi.advanceTimersByTime(1));
  expect(dismiss).not.toHaveBeenCalled();
});
it('handles native printing and removes listeners, timers and observers on unmount', () => {
  const dismiss = vi.fn();
  act(() => root.render(<AnimatedReceiptPrinter onDismiss={dismiss}>Receipt</AnimatedReceiptPrinter>));
  act(() => window.dispatchEvent(new Event('afterprint')));
  expect(dismiss).not.toHaveBeenCalled();
  act(() => root.render(null));
  act(() => { vi.runAllTimers(); window.dispatchEvent(new Event('afterprint')); });
  expect(dismiss).not.toHaveBeenCalled();
  expect(disconnect).toHaveBeenCalled();
});
it('keeps a static receipt when reduced motion is requested', () => {
  reduced = true;
  const dismiss = vi.fn();
  act(() => root.render(<AnimatedReceiptPrinter onDismiss={dismiss}>Receipt</AnimatedReceiptPrinter>));
  act(() => vi.advanceTimersByTime(700));
  expect(dismiss).not.toHaveBeenCalled();
});

it('dismisses on another portal action but not a click inside the receipt', () => {
  const dismiss = vi.fn();
  act(() => root.render(<AnimatedReceiptPrinter onDismiss={dismiss}>Receipt</AnimatedReceiptPrinter>));
  act(() => document.querySelector('section')?.click());
  expect(dismiss).not.toHaveBeenCalled();
  const action = document.createElement('button');
  document.body.append(action);
  act(() => action.click());
  expect(dismiss).toHaveBeenCalledTimes(1);
  action.remove();
});
