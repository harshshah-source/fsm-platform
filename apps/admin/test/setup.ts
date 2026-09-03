import '@testing-library/jest-dom/vitest';

// recharts' ResponsiveContainer relies on ResizeObserver, which jsdom does not implement. Provide a
// no-op so chart-bearing pages render in tests (charts measure 0×0 in jsdom and simply draw nothing).
class ResizeObserverMock {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
if (!('ResizeObserver' in globalThis)) {
  (globalThis as unknown as { ResizeObserver: typeof ResizeObserverMock }).ResizeObserver =
    ResizeObserverMock;
}

// jsdom implements no scrolling, so `Element.prototype.scrollIntoView` does not exist and any call to
// it throws. Provide a no-op so components that bring something on screen (the Console's Inspector on
// a drop) render in tests; a test that cares asserts on this method with `vi.spyOn`.
if (typeof Element.prototype.scrollIntoView !== 'function') {
  Element.prototype.scrollIntoView = function scrollIntoView(): void {};
}
