import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  NotFoundException,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ROOT_CAUSE_CATEGORIES, type TroubleshootSubmissionView } from '@fsm/shared';
import { AccessTokenClaims } from '../auth/token.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { AuthGuard } from '../common/guards/auth.guard';
import { RoleGuard } from '../common/guards/role.guard';
import { TroubleshootSubmitDto } from './dto/troubleshoot-submit.dto';
import { type ConsumedComponent, type SubmissionView, TroubleshootSubmissionService } from './troubleshoot-submission.service';

function serialize(s: SubmissionView): TroubleshootSubmissionView {
  return {
    submissionId: s.submissionId,
    ticketId: s.ticketId,
    seId: s.seId,
    clientSubmissionId: s.clientSubmissionId,
    rootCauseCategory: s.rootCauseCategory,
    componentUnavailable: s.componentUnavailable,
    presenceSource: s.presenceSource,
    seGpsLat: s.seGpsLat,
    seGpsLon: s.seGpsLon,
    submittedAt: s.submittedAt.toISOString(),
  };
}

/** Component ids arrive stringified — JSON has no bigint, and `component_master.component_id` is a
 *  `bigserial`. Only digits: `BigInt('antenna')` is a `SyntaxError`, which used to be a 500. */
const COMPONENT_ID = /^\d+$/;

/**
 * Parse one stringified component id, or refuse the whole request as `UNKNOWN_COMPONENT` (#352).
 *
 * A malformed id and an id that names no catalog row are the same problem told twice — a picker
 * working from a stale or invented catalog — so they get the same code rather than a shape error the
 * client would have to handle separately. The service answers the second half; this answers the first,
 * before `BigInt()` can throw.
 */
function parseComponentId(raw: string): bigint {
  if (!COMPONENT_ID.test(raw)) throw new BadRequestException({ code: 'UNKNOWN_COMPONENT', componentIds: [raw] });
  return BigInt(raw);
}

/**
 * SE troubleshooting-form surface (Issue 16). POST /api/tickets/:id/troubleshoot submits the structured
 * form for the authenticated SE — `root_cause_category` is required (free-text is supplementary), the
 * SE GPS is captured silently, and a duplicate `client_submission_id` is a 200 no-op. SE-only.
 *
 * #352 completed the component half of the contract. The handler now carries `componentUnavailableItem`
 * (required whenever `componentUnavailable` is true — the CHECK constraint behind it used to answer a
 * bare 500, so no `component_requests` row was ever created and the warehouse queue stayed empty) and
 * `consumedComponents` (which the service has been able to book into the inventory ledger since Issue
 * 24, and which nothing could reach). Each refusal has a name the mobile client renders:
 * `COMPONENT_ITEM_REQUIRED`, `UNKNOWN_COMPONENT`, `INSUFFICIENT_VAN_STOCK`.
 */
@Controller('tickets')
@UseGuards(AuthGuard, RoleGuard)
export class TroubleshootController {
  constructor(private readonly submissions: TroubleshootSubmissionService) {}

  @Post(':id/troubleshoot')
  @Roles('SERVICE_ENGINEER')
  async submit(@CurrentUser() user: AccessTokenClaims, @Param('id') ticketId: string, @Body() body: TroubleshootSubmitDto) {
    if (!body.clientSubmissionId) {
      throw new BadRequestException({ code: 'CLIENT_SUBMISSION_ID_REQUIRED' });
    }
    if (!body.rootCauseCategory || !ROOT_CAUSE_CATEGORIES.includes(body.rootCauseCategory)) {
      throw new BadRequestException({ code: 'ROOT_CAUSE_CATEGORY_REQUIRED' });
    }
    // #352 — required-when, answered here rather than by a `@ValidateIf` so the SE's client gets the
    // named code it renders instead of a validator's field message. The service repeats the check for
    // its direct callers; this one exists so the answer is the same over HTTP.
    if (body.componentUnavailable === true && !body.componentUnavailableItem) {
      throw new BadRequestException({ code: 'COMPONENT_ITEM_REQUIRED' });
    }
    const consumedComponents: ConsumedComponent[] = (body.consumedComponents ?? []).map((c) => ({
      componentId: parseComponentId(c.componentId),
      qty: c.qty,
    }));

    const outcome = await this.submissions.submit({
      ticketId,
      seId: user.user_id,
      clientSubmissionId: body.clientSubmissionId,
      rootCauseCategory: body.rootCauseCategory,
      rootCauseSubcategory: body.rootCauseSubcategory,
      rootCauseNotes: body.rootCauseNotes,
      actionTakenCategory: body.actionTakenCategory,
      actionTakenNotes: body.actionTakenNotes,
      diagnosisNotes: body.diagnosisNotes,
      componentUnavailable: body.componentUnavailable,
      componentUnavailableItem: body.componentUnavailableItem ? parseComponentId(body.componentUnavailableItem) : null,
      consumedComponents,
      photoRefs: body.photoRefs,
      seGps: body.seGps,
      actor: { userId: user.user_id, role: user.role },
    });

    if (outcome.result === 'NOT_FOUND') throw new NotFoundException({ code: 'TICKET_NOT_FOUND' });
    if (outcome.result === 'COMPONENT_ITEM_REQUIRED') throw new BadRequestException({ code: 'COMPONENT_ITEM_REQUIRED' });
    if (outcome.result === 'UNKNOWN_COMPONENT') {
      throw new BadRequestException({ code: 'UNKNOWN_COMPONENT', componentIds: outcome.componentIds });
    }
    if (outcome.result === 'INSUFFICIENT_VAN_STOCK') {
      // A 409, not a 400: the request is well-formed and the SE is not wrong about the ticket — the
      // van simply does not hold what the form claims was fitted. Same class of answer as the
      // Business-409 below, and the client shows the parts and the numbers.
      throw new ConflictException({ code: 'INSUFFICIENT_VAN_STOCK', shortages: outcome.shortages });
    }
    if (outcome.result === 'CONFLICT') {
      // Business 409 (CONTEXT §Business 409 Conflict) — distinct from an idempotency duplicate. Carries
      // the winning SE/time for the SE-facing copy and whether consumed components were logged as Shadow Use.
      throw new ConflictException({
        code: 'TICKET_ALREADY_CLOSED',
        status: outcome.status,
        winnerSeId: outcome.conflict.winnerSeId,
        winnerSeName: outcome.conflict.winnerSeName,
        winnerAt: outcome.conflict.winnerAt,
        shadowUseRecorded: outcome.shadowUseRecorded,
      });
    }
    return { result: outcome.result, duplicate: outcome.duplicate, submission: serialize(outcome.submission) };
  }
}
