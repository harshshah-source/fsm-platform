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
