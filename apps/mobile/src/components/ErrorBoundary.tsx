import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { color, radius, spacing, typeScale } from '../theme/tokens';

export interface ErrorBoundaryProps {
  children: ReactNode;
  /** Crash-reporting seam. Nothing wires it yet (no Sentry/Crashlytics in the stack — see
   *  SYSTEM-STATE); it exists so the reporter, when it lands, has one place to attach. */
  onError?: (error: Error, info: ErrorInfo) => void;
}

interface ErrorBoundaryState {
  error: Error | null;
  /** Bumped on retry so the child subtree is remounted rather than re-rendered — a child that
   *  crashed on mount holds broken state otherwise, and retry would be a no-op. */
  attempt: number;
}

/**
 * Root error boundary. An unhandled render throw white-screens a React Native app with no in-app
 * recovery and no way for an SE in the field to report what happened — this renders a readable,
 * retryable screen instead (#209).
 *
 * A class is not a style choice: `componentDidCatch`/`getDerivedStateFromError` have no hooks
 * equivalent, so React still requires a class component for this one job.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null, attempt: 0 };

  static getDerivedStateFromError(error: Error): Pick<ErrorBoundaryState, 'error'> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Until a crash reporter exists this is the only trace of the failure, and it is reachable
    // from a handset over `adb logcat` — which is exactly how #209 verifies device behaviour.
    console.error('[FSM] Unhandled render error', error, info.componentStack);
    this.props.onError?.(error, info);
  }

  private readonly retry = (): void => {
    this.setState((prev) => ({ error: null, attempt: prev.attempt + 1 }));
  };

  render(): ReactNode {
    const { error, attempt } = this.state;
    if (!error) {
      return <View key={attempt} style={styles.fill}>{this.props.children}</View>;
    }

    return (
      <View testID="error-boundary-fallback" style={styles.fallback}>
        <Text style={styles.title}>Something went wrong</Text>
        <Text style={styles.body}>
          The app hit an unexpected error. Try again — if it keeps happening, report the message
          below along with what you were doing.
        </Text>
        <ScrollView style={styles.detailBox} contentContainerStyle={styles.detailContent}>
          <Text testID="error-boundary-detail" style={styles.detail}>
            {error.message || String(error)}
          </Text>
        </ScrollView>
        <Pressable
          testID="error-boundary-retry"
          accessibilityRole="button"
          onPress={this.retry}
          style={styles.retry}
        >
          <Text style={styles.retryLabel}>Try again</Text>
        </Pressable>
      </View>
    );
  }
}

const styles = StyleSheet.create({
  fill: {
    flex: 1,
  },
  fallback: {
    flex: 1,
    justifyContent: 'center',
    backgroundColor: color.surfaceApp,
    padding: spacing.xl,
    gap: spacing.lg,
  },
  title: {
    ...typeScale.pageTitle,
    color: color.inkStrong,
  },
  body: {
    ...typeScale.body,
    color: color.ink,
  },
  detailBox: {
    maxHeight: 160,
    backgroundColor: color.criticalBg,
    borderRadius: radius.md,
  },
  detailContent: {
    padding: spacing.md,
  },
  detail: {
    ...typeScale.cellSecondary,
    color: color.critical,
  },
  retry: {
    alignSelf: 'flex-start',
    backgroundColor: color.brand600,
    borderRadius: radius.lg,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.xl,
  },
  retryLabel: {
    ...typeScale.body,
    fontWeight: '600',
    color: color.onColor,
  },
});
