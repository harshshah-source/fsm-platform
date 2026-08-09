import { StyleSheet, Text, View } from 'react-native';
import type { MeWorkHistoryDay } from '@fsm/shared';
import { color, radius, spacing, typeScale } from '../theme/tokens';

// Proportioned off the reference image, where a bar is a little under 3× as tall as it is wide. Kept
// as a ratio rather than a screen fraction: seven of these have to sit side by side inside the card on
// a narrow handset, so the width is the constrained dimension and the height follows it.
const BAR_WIDTH = 30;
const TRACK_HEIGHT = 88;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * `2026-05-07` → `07 May`, the axis label in `docs/ui/mobile/home-dashboard.png`.
 *
 * Parsed by hand rather than through `new Date(iso)`: the backend already resolved these to IST
 * calendar dates (#175), and handing the string to `Date` would re-interpret it as UTC midnight and
 * then render it in the *device's* zone — an SE whose phone is set west of UTC would read every bar
 * labelled one day early. There is no instant here to convert; the string is already the answer.
 */
export function formatChartDate(isoDate: string): string {
  const [, month, day] = isoDate.split('-');
  const label = MONTHS[Number(month) - 1];
  return label ? `${day} ${label}` : isoDate;
}

/** Fraction of a day's assigned work that closed, clamped into `[0, 1]`. A day with nothing assigned
 *  is 0, not a divide-by-zero — and never `NaN`, which would silently collapse the bar's layout. */
export function completionRatio(day: MeWorkHistoryDay): number {
  if (day.assigned <= 0) return 0;
  return Math.min(1, Math.max(0, day.completed / day.assigned));
}

/**
 * Home's "Assigned vs Completed" chart (#175, `docs/ui/mobile/home-dashboard.png`) — one bar per IST
 * day, oldest left, `completed/assigned` printed above and the date below.
 *
 * **Drawn with plain Views, deliberately.** The obvious tool is `react-native-svg`, but it ships native
 * code: adding it invalidates the installed debug APK and forces a full Android rebuild (see
 * `docs/runbooks/mobile-android-build.md` for what that costs on this project). A stacked pair of
 * rounded views renders this shape exactly, so the dependency buys nothing here.
 *
 * The tracks are uniform height and only the *fill* varies, matching the reference image: the bar
 * encodes the completion rate, and the absolute pair is carried by the `4/6` label above it. Same
 * bar-per-day treatment regardless of magnitude, so a heavy day and a light day stay comparable.
 */
export function WorkHistoryChart({ days }: { days: MeWorkHistoryDay[] }) {
  return (
    <View testID="work-history-chart" style={styles.card}>
      <View style={styles.header}>
        <View style={styles.headerText}>
          <Text style={styles.title}>Assigned vs Completed</Text>
          <Text style={styles.subtitle}>Daily work status</Text>
        </View>
        <View style={styles.legend}>
          <LegendEntry dotColor={color.brand600} label="Completed" />
          <LegendEntry dotColor={color.info} label="Assigned" />
        </View>
      </View>

      {days.length === 0 ? (
        <Text testID="work-history-empty" style={styles.empty}>
          No work history yet.
        </Text>
      ) : (
        <View style={styles.plot}>
          {days.map((day) => (
            <View
              key={day.date}
              testID={`work-history-bar-${day.date}`}
              style={styles.column}
              accessibilityLabel={`${formatChartDate(day.date)}: ${day.completed} of ${day.assigned} completed`}
            >
              <Text style={styles.ratio}>{`${day.completed}/${day.assigned}`}</Text>
              <View style={styles.track}>
                <View
                  testID={`work-history-fill-${day.date}`}
                  style={[styles.fill, { height: Math.round(TRACK_HEIGHT * completionRatio(day)) }]}
                />
              </View>
              <Text style={styles.axis}>{formatChartDate(day.date)}</Text>
            </View>
          ))}
        </View>
      )}
    </View>
  );
}

function LegendEntry({ dotColor, label }: { dotColor: string; label: string }) {
  return (
    <View style={styles.legendEntry}>
      <View style={[styles.legendDot, { backgroundColor: dotColor }]} />
      <Text style={styles.legendLabel}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    marginHorizontal: spacing.lg,
    marginTop: spacing.lg,
    padding: spacing.lg,
    borderRadius: radius.lg,
    backgroundColor: color.surfaceCard,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: spacing.sm,
  },
  headerText: {
    flexShrink: 1,
  },
  title: {
    ...typeScale.pageTitle,
    fontSize: 17,
    lineHeight: 22,
    color: color.inkStrong,
  },
  subtitle: {
    ...typeScale.cellSecondary,
    color: color.inkMuted,
  },
  legend: {
    gap: spacing.xs,
  },
  legendEntry: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs + 2,
  },
  legendDot: {
    width: 8,
    height: 8,
    borderRadius: radius.full,
  },
  legendLabel: {
    ...typeScale.cellSecondary,
    color: color.inkMuted,
  },
  empty: {
    ...typeScale.cellSecondary,
    color: color.inkMuted,
    marginTop: spacing.md,
  },
  // The plot sits on its own sunken panel (reference image) so the bars read as one chart rather than
  // seven loose elements on the card.
  plot: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-end',
    marginTop: spacing.md,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.sm,
    borderRadius: radius.md,
    backgroundColor: color.surfaceRaised,
  },
  column: {
    alignItems: 'center',
    gap: spacing.sm,
    flexShrink: 1,
  },
  ratio: {
    ...typeScale.cellSecondary,
    fontSize: 11,
    fontWeight: '700',
    color: color.inkStrong,
  },
  track: {
    width: BAR_WIDTH,
    height: TRACK_HEIGHT,
    borderRadius: radius.full,
    backgroundColor: color.infoBg,
    // The fill grows from the floor of the track, which is what makes a taller bar read as "more done".
    justifyContent: 'flex-end',
    overflow: 'hidden',
  },
  fill: {
    width: '100%',
    borderRadius: radius.full,
    backgroundColor: color.brand600,
  },
  axis: {
    ...typeScale.cellSecondary,
    fontSize: 10,
    color: color.inkMuted,
  },
});
