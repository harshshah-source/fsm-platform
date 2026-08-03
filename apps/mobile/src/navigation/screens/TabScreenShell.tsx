import { StyleSheet, Text, View } from 'react-native';
import { color, spacing, typeScale } from '../../theme/tokens';

/** Empty tab shell — feature content is the M-series (Issues 55-61); this issue (#54) ships the
 *  nav skeleton only. */
export function TabScreenShell({ title, testID }: { title: string; testID: string }) {
  return (
    <View testID={testID} style={styles.container}>
      <Text style={styles.title}>{title}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: color.surfaceApp,
    padding: spacing.lg,
  },
  title: {
    ...typeScale.pageTitle,
    color: color.inkStrong,
  },
});
