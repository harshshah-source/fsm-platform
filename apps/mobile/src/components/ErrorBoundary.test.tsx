import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { Text } from 'react-native';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { ErrorBoundary } from './ErrorBoundary';

// A render throw is the only way to exercise a boundary, and React logs the caught error to
// console.error regardless of the boundary handling it. Silencing it keeps the suite output
// readable without hiding a genuine unexpected error (each test asserts on rendered output).
let consoleError: ReturnType<typeof jest.spyOn>;

beforeEach(() => {
  consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  consoleError.mockRestore();
});

function Boom({ explode }: { explode: boolean }) {
  if (explode) {
    throw new Error('render exploded');
  }
  return <Text>content</Text>;
}

describe('ErrorBoundary', () => {
  it('renders its children when nothing throws', () => {
    render(
      <ErrorBoundary>
        <Boom explode={false} />
      </ErrorBoundary>,
    );

    expect(screen.getByText('content')).toBeTruthy();
    expect(screen.queryByTestId('error-boundary-fallback')).toBeNull();
  });

  it('renders the fallback screen instead of a white screen when a child throws', () => {
    render(
      <ErrorBoundary>
        <Boom explode={true} />
      </ErrorBoundary>,
    );

    expect(screen.getByTestId('error-boundary-fallback')).toBeTruthy();
    expect(screen.queryByText('content')).toBeNull();
  });

  it('shows the error message so a field report can name what failed', () => {
    render(
      <ErrorBoundary>
        <Boom explode={true} />
      </ErrorBoundary>,
    );

    expect(screen.getByTestId('error-boundary-detail').props.children).toBe('render exploded');
  });

  it('recovers: retry remounts the subtree, and a child that no longer throws renders', () => {
    const { rerender } = render(
      <ErrorBoundary>
        <Boom explode={true} />
      </ErrorBoundary>,
    );
    expect(screen.getByTestId('error-boundary-fallback')).toBeTruthy();

    // The cause has to be gone before retry can succeed — otherwise the remount throws again and
    // the boundary correctly returns to the fallback (asserted below).
    rerender(
      <ErrorBoundary>
        <Boom explode={false} />
      </ErrorBoundary>,
    );
    fireEvent.press(screen.getByTestId('error-boundary-retry'));

    expect(screen.getByText('content')).toBeTruthy();
    expect(screen.queryByTestId('error-boundary-fallback')).toBeNull();
  });

  it('falls back again when retry re-throws, rather than white-screening on the second failure', () => {
    render(
      <ErrorBoundary>
        <Boom explode={true} />
      </ErrorBoundary>,
    );

    fireEvent.press(screen.getByTestId('error-boundary-retry'));

    expect(screen.getByTestId('error-boundary-fallback')).toBeTruthy();
  });

  it('reports the caught error to onError so a future crash reporter has one seam to hook', () => {
    const onError = jest.fn();

    render(
      <ErrorBoundary onError={onError}>
        <Boom explode={true} />
      </ErrorBoundary>,
    );

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0]).toBeInstanceOf(Error);
    expect((onError.mock.calls[0][0] as Error).message).toBe('render exploded');
  });
});
