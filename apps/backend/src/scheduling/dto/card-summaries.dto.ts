import { ArrayMaxSize, IsArray, IsOptional, IsUUID } from 'class-validator';
import { CARD_SUMMARY_LIMIT } from '../dispatch-today-query.service';

/**
 * Request body for `POST /dispatch/card-summaries` (#295) — the ids of the cards a non-today board
 * column is about to draw.
 *
 * Shape-only, as every DTO in this repo is: the global `ValidationPipe` runs
 * `whitelist + forbidNonWhitelisted`, so this rejects unknown keys and wrong types before the handler.
 * The two rules that matter operationally — the caller's zone, and which of these ids actually live
 * in it — are enforced in the service, because they are questions about data rather than about shape.
 *
 * `ArrayMaxSize` and the service's own `TOO_MANY_TICKETS` check are both here on purpose: the
 * decorator refuses an oversized body at the pipe, and the service refuses one however it was called,
 * including from a test or another service that never passes through a pipe.
 */
export class CardSummariesDto {
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(CARD_SUMMARY_LIMIT)
  @IsUUID('4', { each: true })
  ticketIds?: string[];
}
