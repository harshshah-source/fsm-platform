import { Button, Text, View } from 'react-native';
import { useAuth } from './AuthProvider';

export function SessionScreen() {
  const { session, logout } = useAuth();
  if (!session) {
    return null;
  }

  const zoneLabel = session.zone_id === null ? 'All zones' : `Zone ${session.zone_id}`;

  return (
    <View>
      {session.acted_as_role ? (
        <Text accessibilityRole="alert">{`Acting as ${session.acted_as_role}`}</Text>
      ) : null}
      <Text>{session.role}</Text>
      <Text>{zoneLabel}</Text>
      <Button testID="logout" title="Log out" onPress={() => void logout()} />
    </View>
  );
}
