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
import { AccessTokenClaims } from '../auth/token.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { AuthGuard } from '../common/guards/auth.guard';
import { RoleGuard } from '../common/guards/role.guard';
import { type RootCauseCategory } from '../generated/prisma/enums';
import { type SubmissionView, TroubleshootSubmissionService } from './troubleshoot-submission.service';

const ROOT_CAUSE_CATEGORIES: RootCauseCategory[] = [
  'POWER_ISSUE',
  'SIM_NETWORK_ISSUE',
  'GPS_ANTENNA_ISSUE',
  'DEVICE_HARDWARE_FAULT',
  'WIRING_ISSUE',
  'CONFIGURATION_ISSUE',
  'VEHICLE_ACCESS_ISSUE',
  'INSTALLATION_ISSUE',
  'CUSTOMER_SIDE_ISSUE',
  'UNKNOWN',
];

interface TroubleshootBody {
  clientSubmissionId: string;
  rootCauseCategory: RootCauseCategory;
  rootCauseSubcategory?: string;
  rootCauseNotes?: string;
  actionTakenCategory?: string;
  actionTakenNotes?: string;
  diagnosisNotes?: string;
  componentUnavailable?: boolean;
  componentUnavailableItem?: string;
  photoRefs?: string[];
  seGps?: { lat: number; lon: number };
}

function serialize(s: SubmissionView) {
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
    submittedAt: s.submittedAt,
  };
}

/**
 * SE troubleshooting-form surface (Issue 16). POST /api/tickets/:id/troubleshoot submits the structured
 * form for the authenticated SE — `root_cause_category` is required (free-text is supplementary), the
 * SE GPS is captured silently, and a duplicate `client_submission_id` is a 200 no-op. SE-only.
 */
@Controller('tickets')
@UseGuards(AuthGuard, RoleGuard)
export class TroubleshootController {
  constructor(private readonly submissions: TroubleshootSubmissionService) {}

  @Post(':id/troubleshoot')
  @Roles('SERVICE_ENGINEER')
  async submit(@CurrentUser() user: AccessTokenClaims, @Param('id') ticketId: string, @Body() body: TroubleshootBody) {
    if (!body.clientSubmissionId) {
      throw new BadRequestException({ code: 'CLIENT_SUBMISSION_ID_REQUIRED' });
    }
    if (!body.rootCauseCategory || !ROOT_CAUSE_CATEGORIES.includes(body.rootCauseCategory)) {
      throw new BadRequestException({ code: 'ROOT_CAUSE_CATEGORY_REQUIRED' });
    }

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
      componentUnavailableItem: body.componentUnavailableItem ? BigInt(body.componentUnavailableItem) : null,
      photoRefs: body.photoRefs,
      seGps: body.seGps,
      actor: { userId: user.user_id, role: user.role },
    });

    if (outcome.result === 'NOT_FOUND') throw new NotFoundException({ code: 'TICKET_NOT_FOUND' });
    if (outcome.result === 'NOT_OPEN') {
      throw new ConflictException({ code: 'TICKET_NOT_OPEN', status: outcome.status });
    }
    return { result: outcome.result, duplicate: outcome.duplicate, submission: serialize(outcome.submission) };
  }
}
