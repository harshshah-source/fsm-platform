import { useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { BrandMark } from '../components/kit/BrandMark';
import { color, radius, spacing, typeScale } from '../theme/tokens';
import { useAuth } from './AuthProvider';

/**
 * The SE sign-in screen — no reference image exists for it (`docs/ui/mobile/` has none named
 * `login*`), so this is original layout, not a parity build. Centered card over a lightly branded
 * background, `BrandMark` at the top (same wordmark as Home/admin), and a password field with a
 * show/hide toggle so a field engineer can check what they typed before submitting.
 *
 * No imperative navigation on success — the app entry renders off `session` declaratively
 * (admin navigates with react-router; mobile swaps screens when AuthProvider's session is set).
 */
export function LoginScreen() {
  const { login } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = async (): Promise<void> => {
    setError(null);
    setSubmitting(true);
    try {
      await login(email, password);
    } catch {
      setError('Invalid email or password');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView contentContainerStyle={styles.screen} keyboardShouldPersistTaps="handled">
        {/* Two soft brand-tinted washes, the same depth trick Home's header uses — plain Views, no
            gradient dependency. */}
        <View pointerEvents="none" style={styles.decorCircleLarge} />
        <View pointerEvents="none" style={styles.decorCircleSmall} />

        <View style={styles.card}>
          <View style={styles.brandRow}>
            <BrandMark tone="onLight" />
          </View>

          <Text style={styles.heading}>Sign in</Text>
          <Text style={styles.subheading}>Service Engineer login</Text>

          <View style={styles.fieldGroup}>
            <Text style={styles.fieldLabel}>Email</Text>
            <View style={styles.inputRow}>
              <Ionicons name="mail-outline" size={18} color={color.inkMuted} style={styles.inputIcon} />
              <TextInput
                testID="email-input"
                style={styles.textInput}
                placeholder="you@company.com"
                placeholderTextColor={color.inkMuted}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="email-address"
                value={email}
                onChangeText={setEmail}
              />
            </View>
          </View>

          <View style={styles.fieldGroup}>
            <Text style={styles.fieldLabel}>Password</Text>
            <View style={styles.inputRow}>
              <Ionicons name="lock-closed-outline" size={18} color={color.inkMuted} style={styles.inputIcon} />
              <TextInput
                testID="password-input"
                style={[styles.textInput, styles.passwordTextInput]}
                placeholder="Password"
                placeholderTextColor={color.inkMuted}
                secureTextEntry={!showPassword}
                autoCapitalize="none"
                autoCorrect={false}
                value={password}
                onChangeText={setPassword}
              />
              <Pressable
                testID="password-visibility-toggle"
                accessibilityRole="button"
                accessibilityLabel={showPassword ? 'Hide password' : 'Show password'}
                onPress={() => setShowPassword((v) => !v)}
                style={styles.eyeButton}
                hitSlop={8}
              >
                <Ionicons name={showPassword ? 'eye-off-outline' : 'eye-outline'} size={20} color={color.inkMuted} />
              </Pressable>
            </View>
          </View>

          {error ? (
            <Text accessibilityRole="alert" style={styles.error}>
              {error}
            </Text>
          ) : null}

          <Pressable
            testID="submit"
            disabled={submitting}
            accessibilityState={{ disabled: submitting }}
            onPress={() => void onSubmit()}
            style={[styles.submitButton, submitting && styles.submitButtonDisabled]}
          >
            {submitting ? (
              <ActivityIndicator color={color.onColor} />
            ) : (
              <Text style={styles.submitLabel}>Sign in</Text>
            )}
          </Pressable>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: {
    flex: 1,
    backgroundColor: color.surfaceApp,
  },
  screen: {
    flexGrow: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.lg,
  },
  decorCircleLarge: {
    position: 'absolute',
    top: -60,
    right: -80,
    width: 260,
    height: 260,
    borderRadius: 130,
    backgroundColor: 'rgba(185,16,43,0.05)',
  },
  decorCircleSmall: {
    position: 'absolute',
    bottom: -70,
    left: -60,
    width: 200,
    height: 200,
    borderRadius: 100,
    backgroundColor: 'rgba(185,16,43,0.04)',
  },
  card: {
    width: '100%',
    maxWidth: 380,
    backgroundColor: color.surfaceCard,
    borderRadius: radius.lg + 4,
    borderWidth: 1,
    borderColor: color.line,
    padding: spacing.xl,
    // Soft elevation so the centered card lifts off the tinted background — Android and iOS both
    // read these two properties (`elevation` / `shadow*`).
    elevation: 3,
    shadowColor: '#000',
    shadowOpacity: 0.08,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
  },
  brandRow: {
    alignItems: 'center',
    marginBottom: spacing.lg,
  },
  heading: {
    ...typeScale.pageTitle,
    color: color.inkStrong,
    textAlign: 'center',
  },
  subheading: {
    ...typeScale.body,
    color: color.inkMuted,
    textAlign: 'center',
    marginTop: 2,
    marginBottom: spacing.xl,
  },
  fieldGroup: {
    marginBottom: spacing.lg,
  },
  fieldLabel: {
    ...typeScale.cellSecondary,
    fontWeight: '700',
    color: color.ink,
    marginBottom: spacing.xs,
  },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: color.line,
    borderRadius: radius.md,
    backgroundColor: color.surfaceApp,
    paddingHorizontal: spacing.sm,
  },
  inputIcon: {
    marginRight: spacing.xs,
  },
  textInput: {
    ...typeScale.body,
    flex: 1,
    paddingVertical: spacing.sm + 2,
    color: color.inkStrong,
  },
  passwordTextInput: {
    // Room for the eye button so long passwords don't run under it.
    paddingRight: spacing.xs,
  },
  eyeButton: {
    padding: spacing.xs,
  },
  error: {
    ...typeScale.cellSecondary,
    color: color.critical,
    fontWeight: '600',
    marginBottom: spacing.md,
  },
  submitButton: {
    backgroundColor: color.brand600,
    borderRadius: radius.full,
    paddingVertical: spacing.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  submitButtonDisabled: {
    opacity: 0.7,
  },
  submitLabel: {
    ...typeScale.body,
    fontWeight: '700',
    color: color.onColor,
  },
});
