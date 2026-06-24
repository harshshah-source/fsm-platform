import { useState } from 'react';
import { Button, Text, TextInput, View } from 'react-native';
import { useAuth } from './AuthProvider';

export function LoginScreen() {
  const { login } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);

  // No imperative navigation on success — the app entry renders off `session` declaratively
  // (admin navigates with react-router; mobile swaps screens when AuthProvider's session is set).
  const onSubmit = async (): Promise<void> => {
    console.log('[LOGIN] button pressed');
    setError(null);
    try {
      await login(email, password);
    } catch (error) {
      console.log('[LOGIN ERROR]', error);
      setError('Invalid email or password');
    }
  };

  return (
    <View>
      <Text>Sign in</Text>
      <TextInput
        testID="email-input"
        placeholder="Email"
        autoCapitalize="none"
        keyboardType="email-address"
        value={email}
        onChangeText={setEmail}
      />
      <TextInput
        testID="password-input"
        placeholder="Password"
        secureTextEntry
        value={password}
        onChangeText={setPassword}
      />
      {error ? <Text accessibilityRole="alert">{error}</Text> : null}
      <Button testID="submit" title="Sign in" onPress={() => void onSubmit()} />
    </View>
  );
}
