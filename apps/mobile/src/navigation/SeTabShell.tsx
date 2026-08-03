import { NavigationContainer } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { color } from '../theme/tokens';
import { HomeScreen } from './screens/HomeScreen';
import { TicketsScreen } from './screens/TicketsScreen';
import { StockScreen } from './screens/StockScreen';
import { VouchersScreen } from './screens/VouchersScreen';
import { ProfileScreen } from './screens/ProfileScreen';

const Tab = createBottomTabNavigator();

/**
 * The SE mobile shell (#54) — bottom-tab navigation over the five role-visible tabs
 * (PRD §479 screen inventory). Rendered only once `AppEntry` has confirmed
 * `role === 'SERVICE_ENGINEER'`; every tab here is a skeleton, feature content is the
 * M-series (Issues 55-61).
 */
export function SeTabShell() {
  return (
    <NavigationContainer>
      <Tab.Navigator
        screenOptions={{
          headerShown: false,
          tabBarActiveTintColor: color.brand600,
          tabBarInactiveTintColor: color.inkMuted,
        }}
      >
        <Tab.Screen name="Home" component={HomeScreen} options={{ tabBarButtonTestID: 'tab-Home' }} />
        <Tab.Screen name="Tickets" component={TicketsScreen} options={{ tabBarButtonTestID: 'tab-Tickets' }} />
        <Tab.Screen name="Stock" component={StockScreen} options={{ tabBarButtonTestID: 'tab-Stock' }} />
        <Tab.Screen name="Vouchers" component={VouchersScreen} options={{ tabBarButtonTestID: 'tab-Vouchers' }} />
        <Tab.Screen name="Profile" component={ProfileScreen} options={{ tabBarButtonTestID: 'tab-Profile' }} />
      </Tab.Navigator>
    </NavigationContainer>
  );
}
