import { StyleSheet, Text, View } from 'react-native';
import { ProgressBar } from '../components/kit/ProgressBar';
import { color, radius, spacing, typeScale } from '../theme/tokens';

export interface PlantWorkload {
  plantId: string;
  plantName: string;
  /** Tickets on this stop that reached a completed state — the same COMPLETED definition the KPI
   *  strip uses (`homeKpi.ts`), so the two readings of the same day can never disagree. */
  done: number;
  /** Every ticket the day plan put at this plant, done or not. */
  total: number;
}

/** Whole-percent completion for one plant stop. A stop with no tickets is 0%, never `NaN`. */
export function workloadPct(workload: Pick<PlantWorkload, 'done' | 'total'>): number {
  if (workload.total <= 0) return 0;
  return Math.min(100, Math.round((workload.done / workload.total) * 100));
}

/**
 * One card in Home's Plant Workload grid (`docs/ui/mobile/home-dashboard.png`).
 *
 * The reference draws **two** encodings of the same number and they are not redundant: the ring is a
 * static track holding the headline percentage (it is drawn identically on the image's 50% and 0%
 * cards — it is a badge, not a meter), and the horizontal bar underneath is what actually moves. Kept
 * that way rather than "fixed" into a progress ring, because the ring's job here is to make the
 * percentage legible at a glance across a 2-up grid, and a partially-filled ring at small sizes reads
 * worse than a plain one.
 *
 * "work" / "pending" are the image's own words for done / not-yet-done.
 */
export function PlantWorkloadCard({ workload }: { workload: PlantWorkload }) {
  const pct = workloadPct(workload);
  const pending = Math.max(0, workload.total - workload.done);

  return (
    <View testID={`plant-workload-${workload.plantId}`} style={styles.card}>
      <Text style={styles.plant} numberOfLines={2}>
        {workload.plantName}
      </Text>

      <View style={styles.ringWrap}>
        <View style={styles.ring}>
          <Text testID={`plant-workload-pct-${workload.plantId}`} style={styles.pct}>
            {`${pct}%`}
          </Text>
          <Text style={styles.pctCaption}>work</Text>
        </View>
      </View>

      <ProgressBar
        value={workload.done}
        max={workload.total || 1}
        fillColor={color.info}
        trackColor={color.brand300}
        testID={`plant-workload-bar-${workload.plantId}`}
      />

      <View style={styles.legend}>
        <LegendRow dotColor={color.info} label={`${workload.done} work`} />
        <LegendRow dotColor={color.brand600} label={`${pending} pending`} />
      </View>

      <Text testID={`plant-workload-ratio-${workload.plantId}`} style={styles.ratio}>
        {`${workload.done}/${workload.total}`}
      </Text>
    </View>
  );
}

function LegendRow({ dotColor, label }: { dotColor: string; label: string }) {
  return (
    <View style={styles.legendRow}>
      <View style={[styles.legendDot, { backgroundColor: dotColor }]} />
      <Text style={styles.legendLabel}>{label}</Text>
    </View>
  );
}

const RING_SIZE = 92;

const styles = StyleSheet.create({
  card: {
    // Two per row with the grid's gap between them.
    width: '48%',
    padding: spacing.md,
    borderRadius: radius.md,
    backgroundColor: color.surfaceRaised,
    borderWidth: 1,
    borderColor: color.line,
    gap: spacing.sm,
  },
  plant: {
    ...typeScale.cellSecondary,
    fontSize: 13,
    lineHeight: 17,
    fontWeight: '700',
    color: color.inkStrong,
    // Always two lines tall, wrapped or not. Real plant names run from `GGU` to
    // `KALBURGI CEMENT PRIVATE LIMITED-CHATTISGARH`, and without this the cards in a row start their
    // rings at different heights and the grid stops reading as a grid.
    minHeight: 34,
  },
  ringWrap: {
    alignItems: 'center',
    paddingVertical: spacing.xs,
  },
  ring: {
    width: RING_SIZE,
    height: RING_SIZE,
    borderRadius: RING_SIZE / 2,
    borderWidth: 9,
    borderColor: color.infoBg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pct: {
    ...typeScale.pageTitle,
    fontSize: 18,
    lineHeight: 22,
    color: color.inkStrong,
  },
  pctCaption: {
    ...typeScale.cellSecondary,
    fontSize: 10,
    color: color.inkMuted,
  },
  legend: {
    gap: spacing.xs / 2,
  },
  legendRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs + 2,
  },
  legendDot: {
    width: 7,
    height: 7,
    borderRadius: radius.full,
  },
  legendLabel: {
    ...typeScale.cellSecondary,
    fontSize: 11,
    color: color.ink,
  },
  ratio: {
    ...typeScale.cellSecondary,
    fontSize: 11,
    color: color.inkMuted,
    alignSelf: 'flex-end',
  },
});
