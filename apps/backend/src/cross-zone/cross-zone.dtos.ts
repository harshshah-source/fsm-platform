import { Transform } from 'class-transformer';
import { IsDateString, IsInt, IsOptional, IsString, Matches } from 'class-validator';

/**
 * Cross-zone request bodies (#99). Validation here is FORMAT-only and every field is optional:
 * presence rules stay in the controller so its existing `{ code: 'REASON_REQUIRED' }`-style
 * error contracts (consumed by the admin typed-error maps) do not change. What these DTOs add
 * is the edge rejection of *garbage* — `BigInt('junk')` / `Number('junk')` / `new Date('junk')`
 * previously blew up in the handler as a 500; now they 400 at the pipe. Empty strings are
 * normalized to "absent" so the controller's presence checks own that case too.
 */

const emptyToUndefined = ({ value }: { value: unknown }): unknown =>
  value === '' ? undefined : value;

const numberToString = ({ value }: { value: unknown }): unknown =>
  typeof value === 'number' ? String(value) : value;

export class SweepBody {
  @IsOptional()
  @Transform(emptyToUndefined)
  @Transform(numberToString)
  @Matches(/^\d+$/, { message: 'zoneId must be a positive integer' })
  zoneId?: string;
}

export class FlagBody {
  @IsOptional()
  @IsString()
  ticketId?: string;

  @IsOptional()
  @IsString()
  reason?: string;
}

/**
 * #355 (AC3) — `targetZoneId` is optional in the wire sense it always was, but it is no longer the
 * caller's last word on where the work goes. The zone is a *property of the engineer*
 * (`engineer_master.zone_id`), so the service derives it when this is absent and refuses the request
 * when the two disagree. Format validation stays here; the agreement check needs the database and
 * therefore cannot live in a DTO, whatever the plan says.
 */
export class ApproveBody {
  @IsOptional()
  @Transform(emptyToUndefined)
  @Transform(({ value }) => (typeof value === 'string' && value !== '' ? Number(value) : value))
  @IsInt({ message: 'targetZoneId must be an integer' })
  targetZoneId?: number;

  @IsOptional()
  @IsString()
  seId?: string;
}

/** #355 (AC5) — the decision-history window. Garbage bounds 400 at the pipe rather than reaching
 *  `new Date('junk')` and querying on an Invalid Date. */
export class HistoryQuery {
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsDateString({}, { message: 'from must be an ISO date' })
  from?: string;

  @IsOptional()
  @Transform(emptyToUndefined)
  @IsDateString({}, { message: 'to must be an ISO date' })
  to?: string;

  @IsOptional()
  @Transform(emptyToUndefined)
  @Transform(numberToString)
  @Matches(/^\d+$/, { message: 'limit must be a positive integer' })
  limit?: string;
}

export class DenyBody {
  @IsOptional()
  @IsString()
  reason?: string;
}

export class DeferBody {
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsDateString({}, { message: 'reviewDate must be an ISO date' })
  reviewDate?: string;

  @IsOptional()
  @IsString()
  reason?: string;
}
