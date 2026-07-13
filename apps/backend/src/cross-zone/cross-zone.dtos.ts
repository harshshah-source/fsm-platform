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
