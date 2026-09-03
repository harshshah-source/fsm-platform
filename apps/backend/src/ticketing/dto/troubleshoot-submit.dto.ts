import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsInt,
  IsLatitude,
  IsLongitude,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';
import type { ConsumedComponentInput, RootCauseCategory, TroubleshootSubmitRequest } from '@fsm/shared';

/**
 * Request body for `POST /api/tickets/:id/troubleshoot` — #352 (the troubleshoot half of **#174**).
 *
 * **Why this class exists at all.** The handler took `TroubleshootSubmitRequest`, an *interface*, and
 * the global `ValidationPipe` skips interface-typed bodies by design (Nest hands it no class metatype
 * to reflect on). So the SE's most consequential write validated nothing below the two hand-rolled
 * checks in the controller: `componentUnavailableItem` went straight into `BigInt()` (a `SyntaxError`
 * → 500 on any non-numeric string) and `seGps: { lat: 'north' }` reached Prisma as a Float. Both are
 * request questions, and this is where request questions are answered.
 *
 * **Shape only** — the house rule (`scheduling/dto/override-command.dto.ts`, `ops-explorer.dto.ts`).
 * The pipe judges what can be judged from the request alone: types, the interior of
 * `consumedComponents`, and — through `whitelist + forbidNonWhitelisted` — an unknown top-level key.
 * Everything that needs a *fact* stays in `TroubleshootSubmissionService`, which must refuse it however
 * it was called, including from the many specs and services that never pass through a pipe.
 *
 * **The named codes are deliberately not decorators.** `clientSubmissionId`, `rootCauseCategory` and
 * `componentUnavailableItem` are all declared `@IsOptional()` here even though two are required and
 * the third is required-when-`componentUnavailable`. That is not an omission: this route's contract is
 * a `{ code }` body (`CLIENT_SUBMISSION_ID_REQUIRED`, `ROOT_CAUSE_CATEGORY_REQUIRED`,
 * `COMPONENT_ITEM_REQUIRED`, `UNKNOWN_COMPONENT`), which the mobile client reads verbatim
 * (`apps/mobile/src/api/client.ts` — `throw new Error(code)`). A `@IsNotEmpty()` here would win the
 * race and answer `{ message: ["clientSubmissionId should not be empty"] }` instead, silently
 * replacing a sentence the SE can act on with a validator's field name. Presence is therefore the
 * controller's answer to give; *type* is this class's.
 */
export class ConsumedComponentDto implements ConsumedComponentInput {
  /** A `component_master` id, stringified — JSON has no bigint. Parsed (and existence-checked) later. */
  @IsString()
  componentId!: string;

  /** A part is consumed or it is not; 0 and 1.5 are client bugs, not zero-value ledger rows. */
  @IsInt()
  @Min(1)
  qty!: number;
}

/** The SE GPS anchor captured silently at submission — two finite numbers or nothing. */
export class SeGpsDto {
  @IsNumber()
  @IsLatitude()
  lat!: number;

  @IsNumber()
  @IsLongitude()
  lon!: number;
}

export class TroubleshootSubmitDto implements TroubleshootSubmitRequest {
  @IsOptional()
  @IsString()
  clientSubmissionId!: string;

  /** Membership in `ROOT_CAUSE_CATEGORIES` is the controller's check — see the class docstring. */
  @IsOptional()
  @IsString()
  rootCauseCategory!: RootCauseCategory;

  @IsOptional()
  @IsString()
  rootCauseSubcategory?: string;

  @IsOptional()
  @IsString()
  rootCauseNotes?: string;

  @IsOptional()
  @IsString()
  actionTakenCategory?: string;

  @IsOptional()
  @IsString()
  actionTakenNotes?: string;

  @IsOptional()
  @IsString()
  diagnosisNotes?: string;

  @IsOptional()
  @IsBoolean()
  componentUnavailable?: boolean;

  @IsOptional()
  @IsString()
  componentUnavailableItem?: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ConsumedComponentDto)
  consumedComponents?: ConsumedComponentDto[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  photoRefs?: string[];

  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => SeGpsDto)
  seGps?: SeGpsDto;
}
