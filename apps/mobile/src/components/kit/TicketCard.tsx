import { Pressable, StyleSheet, Text, View } from 'react-native';
import { color, radius, spacing, typeScale, type SemanticStatus } from '../../theme/tokens';
import { StatusPill } from './StatusPill';

export interface TicketCardData {
  vehicleNo: string;
  plantName: string;
  gpsId: string;
  transporterName: string;
  issueDescription: string;
  priorityLabel: string;
  priorityStatus: SemanticStatus;
  statusLabel: string;
  statusStatus: SemanticStatus;
}

export interface TicketCardProps {
  ticket: TicketCardData;
  onPress?: () => void;
  /** #171 (transporter phone) is unbuilt — omit both to render without a dead action row. */
  onCall?: () => void;
  onWhatsApp?: () => void;
  /** #66 — the client-side same-day-update cue ("New" for a ZM-added ticket, "Removed" for a
   *  one-session removed label). Absent for every ordinary row. */
  badge?: { label: string; status: SemanticStatus };
}

/** docs/ui/mobile/tickets-priority-view.png row. */
export function TicketCard({ ticket, onPress, onCall, onWhatsApp, badge }: TicketCardProps) {
  const showContactRow = Boolean(onCall || onWhatsApp);
  return (
    <Pressable onPress={onPress} style={styles.card}>
      <View style={styles.headerRow}>
        <Text style={styles.vehicleNo}>{ticket.vehicleNo}</Text>
        <Text style={styles.transporter}>{ticket.transporterName}</Text>
      </View>
      {badge ? (
        <View style={styles.pillRow}>
          <StatusPill label={badge.label} status={badge.status} />
        </View>
      ) : null}
      <Text style={styles.plantName}>{ticket.plantName}</Text>
      <View style={styles.pillRow}>
        <StatusPill label={ticket.priorityLabel} status={ticket.priorityStatus} />
        <StatusPill label={ticket.statusLabel} status={ticket.statusStatus} />
      </View>
      <Text style={styles.gpsId}>{ticket.gpsId}</Text>
      <Text style={styles.issue}>{ticket.issueDescription}</Text>
      {showContactRow ? (
        <View style={styles.contactRow}>
          {onCall ? (
            <Pressable onPress={onCall} style={[styles.contactButton, styles.callButton]}>
              <Text style={styles.contactLabel}>Call</Text>
            </Pressable>
          ) : null}
          {onWhatsApp ? (
            <Pressable onPress={onWhatsApp} style={[styles.contactButton, styles.whatsAppButton]}>
              <Text style={styles.contactLabel}>WhatsApp</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: color.surfaceCard,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: color.line,
    padding: spacing.lg,
    gap: spacing.xs,
  },
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  vehicleNo: {
    ...typeScale.sectionTitle,
    color: color.inkStrong,
  },
  transporter: {
    ...typeScale.cellSecondary,
    color: color.inkMuted,
  },
  plantName: {
    ...typeScale.cellSecondary,
    color: color.inkMuted,
  },
  pillRow: {
    flexDirection: 'row',
    gap: spacing.xs,
    marginTop: spacing.xs,
  },
  gpsId: {
    ...typeScale.cellSecondary,
    color: color.inkCaps,
    marginTop: spacing.xs,
  },
  issue: {
    ...typeScale.body,
    color: color.ink,
  },
  contactRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginTop: spacing.sm,
  },
  contactButton: {
    flex: 1,
    borderRadius: radius.full,
    paddingVertical: spacing.sm,
    alignItems: 'center',
  },
  callButton: {
    backgroundColor: color.infoBg,
  },
  whatsAppButton: {
    backgroundColor: color.successBg,
  },
  contactLabel: {
    ...typeScale.cellSecondary,
    fontWeight: '600',
    color: color.ink,
  },
});
