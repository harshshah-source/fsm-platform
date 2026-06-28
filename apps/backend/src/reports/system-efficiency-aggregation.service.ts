import { Injectable } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/** Result of one day's System Efficiency aggregation run. */
export interface SystemEfficiencyAggregationResult {
  day: string; // ISO date
  rows: number; // partial cube rows written for the day
}

/**
 * System Efficiency Report aggregation worker (Issue 42). `computeDay` rebuilds
 * `system_efficiency_summary_daily` for one UTC day: a set of **partial** cube rows keyed by
 * (day, zone, company, plant, device_type, SE), each carrying one metric family's additive counts /
 * stage-time second-sums. The report read SUMs every partial row matching the filter, so the families
 * need not be merged into one row per key — each `INSERT … SELECT … GROUP BY` populates its own metrics
 * and leaves the rest at their column default 0. Rebuilt per day (delete + insert in a transaction) so
 * recompute is idempotent. On-demand — a BullMQ daily cron wires to it when scheduling lands, same
 * posture as the other report workers.
 *
 * Dimensions come from the ticket's plant (zone) / company / plant and the device's `device_type`. The
 * `se_id` dimension is populated only for **assignment-attributable** metrics (auto-assignments via the
 * Recommendation's SE, overrides via the batch's SE); device / cycle / stage-time metrics are fleet /
 * zone / plant-level (`se_id = NULL`), so an SE filter narrows to the SE-attributable families.
 */
@Injectable()
export class SystemEfficiencyAggregationService {
  constructor(private readonly prisma: PrismaService) {}

  async computeDay(day: Date, now: Date = new Date()): Promise<SystemEfficiencyAggregationResult> {
    const dayStart = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate()));
    const dayEnd = new Date(dayStart.getTime() + 24 * 3600 * 1000);
    const d = Prisma.sql`${dayStart}::date`;

    const rows = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw(Prisma.sql`DELETE FROM system_efficiency_summary_daily WHERE day = ${dayStart}`);

      // 1) Failure cycles opened (detection) + repeat-failure count — dims via the cycle's device state.
      await tx.$executeRaw(Prisma.sql`
        INSERT INTO system_efficiency_summary_daily
          (day, zone_id, company_id, plant_id, device_type, failure_cycles_opened, repeat_failures, computed_at)
        SELECT ${d}, p.zone_id, ds.company_id, ds.plant_id, dv.device_type,
               COUNT(*)::int, COUNT(*) FILTER (WHERE fc.repeat_failure)::int, ${now}
        FROM failure_cycles fc
        LEFT JOIN device_states ds ON ds.device_id = fc.device_id
        LEFT JOIN plants p ON p.plant_id = ds.plant_id
        LEFT JOIN devices dv ON dv.device_id = fc.device_id
        WHERE fc.opened_at >= ${dayStart} AND fc.opened_at < ${dayEnd}
        GROUP BY p.zone_id, ds.company_id, ds.plant_id, dv.device_type`);

      // 2) Tickets created (all + troubleshoot) + detection→ticket stage time.
      await tx.$executeRaw(Prisma.sql`
        INSERT INTO system_efficiency_summary_daily
          (day, zone_id, company_id, plant_id, device_type, tickets_created, troubleshoot_tickets_created,
           detection_to_ticket_seconds_sum, detection_to_ticket_count, computed_at)
        SELECT ${d}, p.zone_id, t.company_id, t.plant_id, dv.device_type,
               COUNT(*)::int,
               COUNT(*) FILTER (WHERE t.work_type = 'TROUBLESHOOT')::int,
               COALESCE(SUM(EXTRACT(EPOCH FROM (t.created_at - fc.opened_at))) FILTER (WHERE fc.opened_at IS NOT NULL), 0)::bigint,
               COUNT(*) FILTER (WHERE fc.opened_at IS NOT NULL)::int,
               ${now}
        FROM tickets t
        LEFT JOIN plants p ON p.plant_id = t.plant_id
        LEFT JOIN devices dv ON dv.device_id = t.device_id
        LEFT JOIN failure_cycles fc ON fc.cycle_id = t.failure_cycle_id
        WHERE t.created_at >= ${dayStart} AND t.created_at < ${dayEnd}
        GROUP BY p.zone_id, t.company_id, t.plant_id, dv.device_type`);

      // 3) Cycles resolved (closed VERIFIED/FAILED) — downtime, first-time-fix, aging, SLA, component pause.
      await tx.$executeRaw(Prisma.sql`
        INSERT INTO system_efficiency_summary_daily
          (day, zone_id, company_id, plant_id, device_type,
           cycles_resolved, verified_cycles, first_time_fixes, aged_resolutions, sla_compliant_resolutions,
           component_pauses, downtime_seconds_sum, computed_at)
        SELECT ${d}, p.zone_id, ds.company_id, ds.plant_id, dv.device_type,
               COUNT(*)::int,
               COUNT(*) FILTER (WHERE fc.state = 'VERIFIED')::int,
               COUNT(*) FILTER (WHERE fc.state = 'VERIFIED' AND NOT fc.repeat_failure AND fc.sla_accumulated_pause_seconds = 0)::int,
               COUNT(*) FILTER (WHERE EXTRACT(EPOCH FROM (fc.closed_at - fc.opened_at)) > 604800)::int,
               COUNT(*) FILTER (WHERE fc.state = 'VERIFIED' AND EXTRACT(EPOCH FROM (fc.closed_at - fc.opened_at)) <= 172800)::int,
               COUNT(*) FILTER (WHERE fc.sla_accumulated_pause_seconds > 0)::int,
               COALESCE(SUM(EXTRACT(EPOCH FROM (fc.closed_at - fc.opened_at))), 0)::bigint,
               ${now}
        FROM failure_cycles fc
        LEFT JOIN device_states ds ON ds.device_id = fc.device_id
        LEFT JOIN plants p ON p.plant_id = ds.plant_id
        LEFT JOIN devices dv ON dv.device_id = fc.device_id
        WHERE fc.closed_at >= ${dayStart} AND fc.closed_at < ${dayEnd} AND fc.state IN ('VERIFIED', 'FAILED')
        GROUP BY p.zone_id, ds.company_id, ds.plant_id, dv.device_type`);

      // 4) Verification outcomes — failed verifications, auto-recoveries, submission→verification stage time.
      await tx.$executeRaw(Prisma.sql`
        INSERT INTO system_efficiency_summary_daily
          (day, zone_id, company_id, plant_id, device_type,
           failed_verifications, auto_recoveries,
           submission_to_verification_seconds_sum, submission_to_verification_count, computed_at)
        SELECT ${d}, p.zone_id, t.company_id, t.plant_id, dv.device_type,
               COUNT(*) FILTER (WHERE vr.outcome = 'FAILED_VERIFICATION')::int,
               COUNT(*) FILTER (WHERE vr.outcome = 'CLOSED_AUTO_RECOVERY')::int,
               COALESCE(SUM(EXTRACT(EPOCH FROM (vr.outcome_at - vr.started_at))), 0)::bigint,
               COUNT(*)::int,
               ${now}
        FROM verification_runs vr
        JOIN tickets t ON t.ticket_id = vr.ticket_id
        LEFT JOIN plants p ON p.plant_id = t.plant_id
        LEFT JOIN devices dv ON dv.device_id = t.device_id
        WHERE vr.outcome_at >= ${dayStart} AND vr.outcome_at < ${dayEnd} AND vr.outcome IS NOT NULL
        GROUP BY p.zone_id, t.company_id, t.plant_id, dv.device_type`);

      // 5) Auto-assignments — Morning-Batch Recommendations dispatched in the day, attributed to the SE.
      await tx.$executeRaw(Prisma.sql`
        INSERT INTO system_efficiency_summary_daily
          (day, zone_id, company_id, plant_id, device_type, se_id, auto_assignments, computed_at)
        SELECT ${d}, p.zone_id, t.company_id, t.plant_id, dv.device_type, r.se_id, COUNT(*)::int, ${now}
        FROM recommendations r
        JOIN tickets t ON t.ticket_id = r.ticket_id
        LEFT JOIN plants p ON p.plant_id = t.plant_id
        LEFT JOIN devices dv ON dv.device_id = t.device_id
        WHERE r.created_at >= ${dayStart} AND r.created_at < ${dayEnd} AND r.path = 'MORNING_BATCH'
        GROUP BY p.zone_id, t.company_id, t.plant_id, dv.device_type, r.se_id`);

      // 6) Manual assignments — one-click / same-day / cross-zone assignment audit rows (entity = ticket).
      await tx.$executeRaw(Prisma.sql`
        INSERT INTO system_efficiency_summary_daily
          (day, zone_id, company_id, plant_id, device_type, manual_assignments, computed_at)
        SELECT ${d}, p.zone_id, t.company_id, t.plant_id, dv.device_type, COUNT(*)::int, ${now}
        FROM audit_logs al
        JOIN tickets t ON t.ticket_id = al.entity_id::uuid
        LEFT JOIN plants p ON p.plant_id = t.plant_id
        LEFT JOIN devices dv ON dv.device_id = t.device_id
        WHERE al.created_at >= ${dayStart} AND al.created_at < ${dayEnd}
          AND al.entity_type = 'ticket'
          AND al.action IN ('CRITICAL_ASSIGN', 'MANUAL_ZM_UPDATE', 'CROSS_ZONE_ASSIGN')
        GROUP BY p.zone_id, t.company_id, t.plant_id, dv.device_type`);

      // 7) Overrides — batch-override audit rows (entity = plant_batch_assignment), attributed to the SE.
      await tx.$executeRaw(Prisma.sql`
        INSERT INTO system_efficiency_summary_daily
          (day, zone_id, plant_id, se_id, overrides, computed_at)
        SELECT ${d}, p.zone_id, pba.plant_id, pba.se_id, COUNT(*)::int, ${now}
        FROM audit_logs al
        JOIN plant_batch_assignments pba ON pba.batch_id = al.entity_id::bigint
        LEFT JOIN plants p ON p.plant_id = pba.plant_id
        WHERE al.created_at >= ${dayStart} AND al.created_at < ${dayEnd}
          AND al.entity_type = 'plant_batch_assignment'
          AND (al.action LIKE 'BATCH_OVERRIDE_%' OR al.action = 'OVERRIDE_AFTER_ON_SITE')
        GROUP BY p.zone_id, pba.plant_id, pba.se_id`);

      // 8) ticket→assignment + assignment→ON_SITE + ON_SITE→submission stage times (per-ticket event MINs).
      await tx.$executeRaw(Prisma.sql`
        INSERT INTO system_efficiency_summary_daily
          (day, zone_id, company_id, plant_id, device_type,
           ticket_to_assignment_seconds_sum, ticket_to_assignment_count,
           assignment_to_onsite_seconds_sum, assignment_to_onsite_count,
           onsite_to_submission_seconds_sum, onsite_to_submission_count, computed_at)
        SELECT ${d}, p.zone_id, t.company_id, t.plant_id, dv.device_type,
               COALESCE(SUM(EXTRACT(EPOCH FROM (asg.assigned_at - t.created_at)))
                        FILTER (WHERE asg.assigned_at >= ${dayStart} AND asg.assigned_at < ${dayEnd}), 0)::bigint,
               COUNT(*) FILTER (WHERE asg.assigned_at >= ${dayStart} AND asg.assigned_at < ${dayEnd})::int,
               COALESCE(SUM(EXTRACT(EPOCH FROM (os.onsite_at - asg.assigned_at)))
                        FILTER (WHERE os.onsite_at >= ${dayStart} AND os.onsite_at < ${dayEnd} AND asg.assigned_at IS NOT NULL), 0)::bigint,
               COUNT(*) FILTER (WHERE os.onsite_at >= ${dayStart} AND os.onsite_at < ${dayEnd} AND asg.assigned_at IS NOT NULL)::int,
               COALESCE(SUM(EXTRACT(EPOCH FROM (sub.submitted_at - os.onsite_at)))
                        FILTER (WHERE sub.submitted_at >= ${dayStart} AND sub.submitted_at < ${dayEnd} AND os.onsite_at IS NOT NULL), 0)::bigint,
               COUNT(*) FILTER (WHERE sub.submitted_at >= ${dayStart} AND sub.submitted_at < ${dayEnd} AND os.onsite_at IS NOT NULL)::int,
               ${now}
        FROM tickets t
        LEFT JOIN plants p ON p.plant_id = t.plant_id
        LEFT JOIN devices dv ON dv.device_id = t.device_id
        LEFT JOIN (SELECT ticket_id, MIN(created_at) AS assigned_at FROM batch_assignment_tickets GROUP BY ticket_id) asg ON asg.ticket_id = t.ticket_id
        LEFT JOIN (SELECT ticket_id, MIN(set_at) AS onsite_at FROM soft_states WHERE type = 'ON_SITE' GROUP BY ticket_id) os ON os.ticket_id = t.ticket_id
        LEFT JOIN (SELECT ticket_id, MIN(submitted_at) AS submitted_at FROM troubleshooting_submissions GROUP BY ticket_id) sub ON sub.ticket_id = t.ticket_id
        WHERE (asg.assigned_at >= ${dayStart} AND asg.assigned_at < ${dayEnd})
           OR (os.onsite_at >= ${dayStart} AND os.onsite_at < ${dayEnd})
           OR (sub.submitted_at >= ${dayStart} AND sub.submitted_at < ${dayEnd})
        GROUP BY p.zone_id, t.company_id, t.plant_id, dv.device_type`);

      // 9) Warehouse fulfilment time — Component Requests received in the day (received_at − created_at).
      await tx.$executeRaw(Prisma.sql`
        INSERT INTO system_efficiency_summary_daily
          (day, zone_id, company_id, plant_id, device_type,
           warehouse_fulfilment_seconds_sum, warehouse_fulfilment_count, computed_at)
        SELECT ${d}, p.zone_id, t.company_id, t.plant_id, dv.device_type,
               COALESCE(SUM(EXTRACT(EPOCH FROM (cr.received_at - cr.created_at))), 0)::bigint, COUNT(*)::int, ${now}
        FROM component_request cr
        JOIN tickets t ON t.ticket_id = cr.ticket_id
        LEFT JOIN plants p ON p.plant_id = t.plant_id
        LEFT JOIN devices dv ON dv.device_id = t.device_id
        WHERE cr.received_at >= ${dayStart} AND cr.received_at < ${dayEnd}
        GROUP BY p.zone_id, t.company_id, t.plant_id, dv.device_type`);

      // 10) Recovery closure time — RECOVERY tickets closed in the day (last event → ticket created_at).
      await tx.$executeRaw(Prisma.sql`
        INSERT INTO system_efficiency_summary_daily
          (day, zone_id, company_id, plant_id, device_type,
           recovery_closure_seconds_sum, recovery_closure_count, computed_at)
        SELECT ${d}, p.zone_id, t.company_id, t.plant_id, dv.device_type,
               COALESCE(SUM(EXTRACT(EPOCH FROM (ev.closed_at - t.created_at))), 0)::bigint, COUNT(*)::int, ${now}
        FROM tickets t
        JOIN (SELECT ticket_id, MAX(at) AS closed_at FROM ticket_events
              WHERE to_state IN ('CLOSED', 'FAILED_RECOVERY', 'RECEIVED_AT_WAREHOUSE') GROUP BY ticket_id) ev ON ev.ticket_id = t.ticket_id
        LEFT JOIN plants p ON p.plant_id = t.plant_id
        LEFT JOIN devices dv ON dv.device_id = t.device_id
        WHERE t.work_type = 'RECOVERY' AND ev.closed_at >= ${dayStart} AND ev.closed_at < ${dayEnd}
        GROUP BY p.zone_id, t.company_id, t.plant_id, dv.device_type`);

      // 11) Auto-escalations per zone — cross-zone AUTO_PLATINUM + intra-day ESCALATION_REQUIRED + cycle ESCALATED.
      await tx.$executeRaw(Prisma.sql`
        INSERT INTO system_efficiency_summary_daily (day, zone_id, auto_escalations, computed_at)
        SELECT ${d}, home_zone_id, COUNT(*)::int, ${now}
        FROM cross_zone_escalations
        WHERE created_at >= ${dayStart} AND created_at < ${dayEnd} AND escalation_type = 'AUTO_PLATINUM'
        GROUP BY home_zone_id`);
      await tx.$executeRaw(Prisma.sql`
        INSERT INTO system_efficiency_summary_daily (day, zone_id, auto_escalations, computed_at)
        SELECT ${d}, zone_id, COUNT(*)::int, ${now}
        FROM intraday_insertions
        WHERE updated_at >= ${dayStart} AND updated_at < ${dayEnd} AND status = 'ESCALATION_REQUIRED'
        GROUP BY zone_id`);

      const [{ count }] = await tx.$queryRaw<{ count: bigint }[]>(
        Prisma.sql`SELECT COUNT(*)::bigint AS count FROM system_efficiency_summary_daily WHERE day = ${dayStart}`,
      );
      return Number(count);
    });

    return { day: dayStart.toISOString().slice(0, 10), rows };
  }
}
