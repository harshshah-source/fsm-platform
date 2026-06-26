import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  HttpCode,
  NotFoundException,
  Post,
  UseGuards,
} from '@nestjs/common';
import { AccessTokenClaims } from '../auth/token.service';
import { CurrentActor } from '../common/decorators/current-actor.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { AuthGuard } from '../common/guards/auth.guard';
import { RoleGuard } from '../common/guards/role.guard';
import type { RequestActor } from '../common/request-actor';
import {
  type InstallRowError,
  type InstallRowInput,
  InstallService,
  type InstallTicketView,
} from './install.service';

/** Creator roles for Install Tickets (ADR-0011): ZM own zone, CSM scope, Operations Head all zones. */
const CREATOR_ROLES = ['ZONAL_MANAGER', 'CENTRAL_SERVICE_MANAGER', 'OPERATIONS_HEAD'] as const;

interface SingleBody {
  vehicleNo?: string;
  plantId?: string;
  companyId?: string;
  deviceType?: string;
  deviceId?: string;
  simId?: string;
  targetDate?: string;
  notes?: string;
}

interface UploadBody {
  csv?: string;
}

/** Row-error → HTTP status: existence → 404, active-mapping conflict → 409, zone authority → 403. */
function throwForRowError(code: InstallRowError): never {
  switch (code) {
    case 'VEHICLE_NOT_FOUND':
    case 'DEVICE_NOT_FOUND':
    case 'PLANT_NOT_FOUND':
    case 'COMPANY_NOT_FOUND':
      throw new NotFoundException({ code });
    case 'VEHICLE_ALREADY_MAPPED':
    case 'DEVICE_ALREADY_MAPPED':
      throw new ConflictException({ code });
    case 'ZONE_FORBIDDEN':
      throw new ForbiddenException({ code });
  }
}

/**
 * Install Ticket creation surface (`/api/install`, Issue 33 / ADR-0011). Single-create and CSV bulk
 * upload, restricted to the manager creator roles and scoped per-zone in the service. Uses
 * `@CurrentUser()` for the zone-authority scope and `@CurrentActor()` so a CSM / Operations Head
 * acting in a ZM's zone has `acted_as_role` audited (#47).
 */
@Controller('install')
@UseGuards(AuthGuard, RoleGuard)
export class InstallController {
  constructor(private readonly install: InstallService) {}

  @Post()
  @Roles(...CREATOR_ROLES)
  async createSingle(
    @CurrentUser() user: AccessTokenClaims,
    @CurrentActor() actor: RequestActor,
    @Body() body: SingleBody,
  ): Promise<InstallTicketView> {
    const row = parseSingleBody(body);
    const out = await this.install.createSingle(
      row,
      { role: user.role, zoneId: user.zone_id },
      actor,
    );
    if (out.result === 'ERROR') throwForRowError(out.code);
    return out.ticket;
  }

  @Post('upload')
  @HttpCode(201)
  @Roles(...CREATOR_ROLES)
  async upload(
    @CurrentUser() user: AccessTokenClaims,
    @CurrentActor() actor: RequestActor,
    @Body() body: UploadBody,
  ): Promise<{ created: string[]; batchId: string }> {
    if (typeof body.csv !== 'string' || body.csv.trim() === '') {
      throw new BadRequestException({ code: 'CSV_REQUIRED' });
    }
    const out = await this.install.uploadCsv(body.csv, { role: user.role, zoneId: user.zone_id }, actor);
    if (out.result === 'INVALID') {
      throw new BadRequestException({ code: 'CSV_VALIDATION_FAILED', errors: out.errors });
    }
    return { created: out.ticketIds, batchId: out.batchId };
  }
}

function parseSingleBody(body: SingleBody): InstallRowInput {
  const vehicleNo = (body.vehicleNo ?? '').trim();
  const plantId = parseId(body.plantId, 'plantId');
  const companyId = parseId(body.companyId, 'companyId');
  const deviceId = parseId(body.deviceId, 'deviceId');
  if (!vehicleNo) throw new BadRequestException({ code: 'MISSING_REQUIRED_FIELD', field: 'vehicleNo' });

  let targetDate: Date | null = null;
  if (body.targetDate) {
    const d = new Date(body.targetDate);
    if (Number.isNaN(d.getTime())) throw new BadRequestException({ code: 'INVALID_TARGET_DATE' });
    targetDate = d;
  }

  return {
    vehicleNo,
    plantId,
    companyId,
    deviceId,
    deviceType: body.deviceType?.trim() || null,
    simId: body.simId?.trim() || null,
    targetDate,
    notes: body.notes?.trim() || null,
  };
}

function parseId(raw: string | undefined, field: string): bigint {
  if (raw === undefined || !/^\d+$/.test(String(raw).trim())) {
    throw new BadRequestException({ code: 'INVALID_ID', field });
  }
  return BigInt(String(raw).trim());
}
