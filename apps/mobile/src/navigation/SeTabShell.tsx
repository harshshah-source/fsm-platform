import { Fragment } from 'react';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { Ionicons } from '@expo/vector-icons';
import { color } from '../theme/tokens';
import { HomeScreen } from './screens/HomeScreen';
import { TicketsScreen } from './screens/TicketsScreen';
import { StockScreen } from './screens/StockScreen';
import { VouchersScreen } from './screens/VouchersScreen';
import { ProfileScreen } from './screens/ProfileScreen';

const Tab = createBottomTabNavigator();

/**
 * `@react-navigation/bottom-tabs` renders its own `MissingIcon` placeholder — a plain bordered box
 * — whenever a tab has no `tabBarIcon`, which none of these five did. That placeholder was showing
 * on every tab, on every screen, for the whole life of this app so far; this map is the fix, not a
 * cosmetic add-on. Outline glyph inactive, filled glyph active — Ionicons ships as a font asset via
 * `@expo/vector-icons` (already a resolved dependency, no native module to add) so this needs no
 * rebuild. Vouchers uses "receipt" rather than the reference image's bell glyph: a bell already
 * means notifications elsewhere in this app (the Home header), and a voucher genuinely is a receipt.
 */
const TAB_ICONS: Record<string, { outline: keyof typeof Ionicons.glyphMap; filled: keyof typeof Ionicons.glyphMap }> = {
  Home: { outline: 'home-outline', filled: 'home' },
  Tickets: { outline: 'list-outline', filled: 'list' },
  Stock: { outline: 'cube-outline', filled: 'cube' },
  Vouchers: { outline: 'receipt-outline', filled: 'receipt' },
  Profile: { outline: 'person-outline', filled: 'person' },
};

/**
 * The SE mobile shell (#54) — bottom-tab navigation over the five role-visible tabs
 * (PRD §479 screen inventory). Rendered only once `AppEntry` has confirmed
 * `role === 'SERVICE_ENGINEER'`; every tab here is a skeleton, feature content is the
 * M-series (Issues 55-61).
 *
 * **#268 retirement.** This used to gate the tab navigator behind a one-time mount check for a live
 * intra-day CRITICAL insertion offer (#77), plus a ghost-assignment toast for an offer that had
 * already been rerouted before the SE responded. Both are gone: #268 retired SE Acceptance from the
 * CRITICAL path entirely (#258 Q3) — a CRITICAL ticket is assigned directly, with no offer step for
 * there to be a pending one of, and no reroute for a ghost-assignment notice to ever describe. The
 * assigned ticket now simply appears through the normal Day Plan flow — see `TicketsScreen`'s badge
 * logic, which derives "CRITICAL INSERTION" from the ticket's own SLA bucket rather than from a flag
 * this shell used to thread down after an accept. `#201` (open) is a *future*, distinct push signal
 * for "new work landed"; nothing here anticipates it.
 */
export function SeTabShell() {
  // No `NavigationContainer` here. `expo-router` owns the single root container (`app/_layout.tsx`
  // renders `<Slot />`), and this shell mounts *inside* that tree — a second container throws
  // "Looks like you have nested a 'NavigationContainer' inside another" and the app dies on the
  // ErrorBoundary right after an SE logs in. The tab navigator nests under the root container fine;
  // only the container itself must be unique. Tests must supply their own container (see
  // `SeTabShell.test.tsx`), because in production the app root is what provides it.
  return (
    <Fragment>
      <Tab.Navigator
        screenOptions={({ route }) => ({
          headerShown: false,
          tabBarActiveTintColor: color.brand600,
          tabBarInactiveTintColor: color.inkMuted,
          tabBarIcon: ({ focused, color: tintColor, size }) => {
            const icons = TAB_ICONS[route.name];
            return <Ionicons name={focused ? icons.filled : icons.outline} size={size} color={tintColor} />;
          },
        })}
      >
        <Tab.Screen name="Home" component={HomeScreen} options={{ tabBarButtonTestID: 'tab-Home' }} />
        <Tab.Screen name="Tickets" component={TicketsScreen} options={{ tabBarButtonTestID: 'tab-Tickets' }} />
        <Tab.Screen name="Stock" component={StockScreen} options={{ tabBarButtonTestID: 'tab-Stock' }} />
        <Tab.Screen name="Vouchers" component={VouchersScreen} options={{ tabBarButtonTestID: 'tab-Vouchers' }} />
        <Tab.Screen name="Profile" component={ProfileScreen} options={{ tabBarButtonTestID: 'tab-Profile' }} />
      </Tab.Navigator>
    </Fragment>
  );
}
