import { Transform } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  Min,
  ValidateIf,
} from 'class-validator';
import type { OverrideCommand } from '../override.service';

/**
 * Request body for `POST /batches/:id/override` and its preview — #310 (CB-3).
 *
 * **Why this class exists at all.** `OverrideCommand` is a TypeScript *union*, and the global
 * `ValidationPipe` skips interface-typed bodies by design (Nest hands it no class metatype to reflect
 * on). So the one door whose contract says "mandatory reason" validated nothing: `reasonCode` wrote
 * through as NULL onto the accountability record #275/#282 read back, and a missing `ticketId` reached
 * Prisma as a 500. The sibling door on the same concept (`intraday-updates.controller.ts:82,102`) has
 * always answered 400 to both; this closes the asymmetry rather than inventing a new rule.
 *
 * **Shape only.** As with every DTO here, the questions about *data* — does this batch exist, is it in
 * the caller's zone, is the SE ON_SITE, is the ticket held — stay in `OverrideService`, which must
 * refuse them however it was called, including from the many specs and services that never pass
 * through a pipe. This refuses only what can be judged from the request itself.
 *
 * ## Three decisions worth stating
 *
 * **1. `action` is not enumerated.** An action this build does not implement is, in practice, the
 * admin bundle deployed ahead of the API — and `batches-controller.e2e-spec.ts` pins the answer to
 * that: `UNSUPPORTED_ACTION`, with a sentence naming the real problem, from the service's own
 * exhaustive switch. An `@IsIn` here would replace it with a generic field error that blames the
 * client for a deploy-ordering problem. So the pipe checks that an action was named; the service still
 * decides whether it exists.
 *
 * **2. One flat class, not seven.** `whitelist + forbidNonWhitelisted` means every field any action
 * uses has to be declared here, so a `DEFER_TICKET` body is free to carry a `stopSequence` this build
 * ignores. That is the accepted cost of not shipping a discriminated-union pipe: the fields each action
 * genuinely *needs* are still required, per action, through `@ValidateIf`. Extra fields were always
 * ignored; missing ones were the defect.
 *
 * **3. Dates are checked for shape here and for meaning in the service.** `YYYY-MM-DD` is a request
 * question. "Is that date in the past" is a question about today, which the service already owns for
 * `MOVE_TICKET` (`TARGET_DATE_IN_PAST`) and now also for `DEFER_TICKET` — and which a caller passing an
 * explicit `now` must be able to answer against *their* clock, not the pipe's.
 */

/** Actions that cannot act without naming one ticket. */
const NEEDS_TICKET_ID = new Set(['REMOVE_TICKET', 'DEFER_TICKET', 'REASSIGN', 'MOVE_TICKET']);
/** Actions that move work to another engineer. */
const NEEDS_NEW_SE = new Set(['SWAP_SE', 'REASSIGN', 'SPLIT_BATCH', 'MOVE_TICKET']);

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A uuid **as Postgres accepts one**, not as RFC 4122 defines one — deliberately not `@IsUUID`.
 *
 * `ticket_id` and the engineer ids are `@db.Uuid` columns, so the boundary that matters is what the
 * database will take: any 8-4-4-4-12 hex string. `@IsUUID` additionally insists on a valid version
 * nibble, which would refuse ids this repo's own fixtures and specs use
 * (`00000000-0000-0000-0000-0000000000aa`) while adding nothing — a v1 uuid is no more real a ticket
 * than a v4 one, and whether the row exists is the service's question, not the pipe's.
 *
 * What this does buy is the whole point of AC1: a `ticketId` of `'abc'` reaches a `uuid` column as a
 * Postgres cast error, i.e. a 500 on input the caller typed.
 */
const PG_UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export class OverrideCommandDto {
  /** Free-form on purpose — see decision 1 above. */
  @IsString()
  @IsNotEmpty()
  action!: string;

  /**
   * The mandatory reason, trimmed before it is judged: `"   "` is an empty accountability record with
   * extra characters, and it is what the operator's own form would send if a required field were
   * whitespace. Trimming in the pipe also means the service and the audit row see the same value the
   * validator approved.
   */
  @IsString()
  @IsNotEmpty()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  reasonCode!: string;

  @ValidateIf((o: OverrideCommandDto) => NEEDS_TICKET_ID.has(o.action))
  @Matches(PG_UUID, { message: 'ticketId must be a uuid.' })
  ticketId?: string;

  @ValidateIf((o: OverrideCommandDto) => NEEDS_NEW_SE.has(o.action))
  @Matches(PG_UUID, { message: 'newSeId must be a uuid.' })
  newSeId?: string;

  /** `SPLIT_BATCH` only. An empty list is a split that splits nothing — refused, not committed. */
  @ValidateIf((o: OverrideCommandDto) => o.action === 'SPLIT_BATCH')
  @IsArray()
  @ArrayNotEmpty()
  @Matches(PG_UUID, { each: true, message: 'ticketIds must all be uuids.' })
  ticketIds?: string[];

  /** `REORDER` only. Stop numbers are 1-based (`max(stop_sequence) + 1`). */
  @ValidateIf((o: OverrideCommandDto) => o.action === 'REORDER')
  @IsInt()
  @Min(1)
  stopSequence?: number;

  /** `DEFER_TICKET` only — the day the work comes back. Strictly future; the service rules on that. */
  @ValidateIf((o: OverrideCommandDto) => o.action === 'DEFER_TICKET')
  @Matches(DATE_ONLY, { message: 'deferredToDate must be an IST calendar day, YYYY-MM-DD.' })
  deferredToDate?: string;

  /** `MOVE_TICKET` only — the operating day to move onto. Today is legal; the service rules on that. */
  @ValidateIf((o: OverrideCommandDto) => o.action === 'MOVE_TICKET')
  @Matches(DATE_ONLY, { message: 'targetDate must be an IST operating day, YYYY-MM-DD.' })
  targetDate?: string;

  @IsOptional()
  @IsBoolean()
  confirm?: boolean;
}

/**
 * The validated body, as the service's union.
 *
 * The cast is the one place the two type worlds meet, and it is honest precisely because it is here:
 * the pipe has already proved every field the named action requires is present and well-shaped, and an
 * action the union does not contain is carried through deliberately so `OverrideService`'s `default:`
 * branch can answer `UNSUPPORTED_ACTION` rather than the pipe answering for it.
 */
export const asOverrideCommand = (dto: OverrideCommandDto): OverrideCommand => dto as unknown as OverrideCommand;
