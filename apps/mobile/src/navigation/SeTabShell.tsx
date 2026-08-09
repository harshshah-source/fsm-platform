import { Fragment, useCallback, useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { Ionicons } from '@expo/vector-icons';
import type { IntradayInsertionOffer, NotificationListItem } from '@fsm/shared';
import { apiGetMyIntradayOffers, apiGetNotifications, apiMarkNotificationRead } from '../api/client';
import { getAccessToken } from '../auth/tokenStore';
import { IntradayOfferScreen } from '../intraday/IntradayOfferScreen';
import { color, spacing, typeScale } from '../theme/tokens';
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
 * #77 — a one-time check on mount (no push dependency, no polling — same "no push on the core
 * path" posture #71's Install activation result used) for a live intra-day CRITICAL insertion
 * offer: if one exists, the tab navigator is gated behind the full-screen Accept/Decline prompt.
 * Once resolved, an accepted ticketId is threaded to `TicketsScreen` so it can badge that row
 * CRITICAL INSERTION (riding #66's existing addedIds mechanism — see `badgeFor` there). A ghost-
 * assignment notice (already-rerouted offer the SE missed) surfaces as a dismissible toast, read
 * off the generic Issue-03 notification list — not gated behind #85/#89.
 */
export function SeTabShell() {
  const [offer, setOffer] = useState<IntradayInsertionOffer | null>(null);
  const [checked, setChecked] = useState(false);
  const [justAcceptedTicketId, setJustAcceptedTicketId] = useState<string | null>(null);
  const [ghostNotification, setGhostNotification] = useState<NotificationListItem | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const token = await getAccessToken();
        if (!token) return;
        const [offers, notifications] = await Promise.all([
          apiGetMyIntradayOffers(token),
          apiGetNotifications(token, { unreadOnly: true }),
        ]);
        if (cancelled) return;
        if (offers.items.length > 0) setOffer(offers.items[0]);
        const ghost = notifications.items.find((n) => n.type === 'INTRADAY_GHOST_ASSIGNMENT');
        if (ghost) setGhostNotification(ghost);
      } catch {
        // Best-effort — a failed check never blocks the SE from reaching their tabs.
      } finally {
        if (!cancelled) setChecked(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleOfferResolved = useCallback((acceptedTicketId: string | null) => {
    setOffer(null);
    if (acceptedTicketId) setJustAcceptedTicketId(acceptedTicketId);
  }, []);

  const handleDismissGhostToast = useCallback(async () => {
    const notification = ghostNotification;
    setGhostNotification(null);
    if (!notification) return;
    const token = await getAccessToken();
    if (!token) return;
    try {
      await apiMarkNotificationRead(token, notification.id);
    } catch {
      // Best-effort — a failed markRead just means it may resurface next check, not a crash.
    }
  }, [ghostNotification]);

  if (!checked) {
    return <View testID="setabshell-checking" style={styles.checking} />;
  }

  if (offer) {
    return <IntradayOfferScreen offer={offer} onResolved={handleOfferResolved} />;
  }

  // No `NavigationContainer` here. `expo-router` owns the single root container (`app/_layout.tsx`
  // renders `<Slot />`), and this shell mounts *inside* that tree — a second container throws
  // "Looks like you have nested a 'NavigationContainer' inside another" and the app dies on the
  // ErrorBoundary right after an SE logs in. The tab navigator nests under the root container fine;
  // only the container itself must be unique. Tests must supply their own container (see
  // `SeTabShell.test.tsx`), because in production the app root is what provides it.
  return (
    <Fragment>
      {ghostNotification ? (
        <View testID="ghost-assignment-toast" style={styles.toast}>
          <Text style={styles.toastText}>{ghostNotification.body}</Text>
          <Pressable testID="ghost-assignment-toast-dismiss" onPress={() => void handleDismissGhostToast()}>
            <Text style={styles.toastDismiss}>×</Text>
          </Pressable>
        </View>
      ) : null}
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
        <Tab.Screen name="Tickets" options={{ tabBarButtonTestID: 'tab-Tickets' }}>
          {() => <TicketsScreen justAcceptedTicketId={justAcceptedTicketId} />}
        </Tab.Screen>
        <Tab.Screen name="Stock" component={StockScreen} options={{ tabBarButtonTestID: 'tab-Stock' }} />
        <Tab.Screen name="Vouchers" component={VouchersScreen} options={{ tabBarButtonTestID: 'tab-Vouchers' }} />
        <Tab.Screen name="Profile" component={ProfileScreen} options={{ tabBarButtonTestID: 'tab-Profile' }} />
      </Tab.Navigator>
    </Fragment>
  );
}

const styles = StyleSheet.create({
  checking: {
    flex: 1,
    backgroundColor: color.surfaceApp,
  },
  toast: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
    padding: spacing.md,
    backgroundColor: color.surfaceCard,
    borderBottomWidth: 1,
    borderBottomColor: color.line,
  },
  toastText: {
    ...typeScale.cellSecondary,
    color: color.ink,
    flex: 1,
  },
  toastDismiss: {
    ...typeScale.body,
    fontWeight: '700',
    color: color.inkMuted,
    paddingHorizontal: spacing.sm,
  },
});
