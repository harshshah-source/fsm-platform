import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';

/** The slice of the express request/response this filter touches (repo style: structural, no express dep). */
interface HttpRequestLike {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
}
interface HttpResponseLike {
  setHeader(name: string, value: string): unknown;
  status(code: number): { json(body: unknown): unknown };
}

/**
 * Global exception filter (#98 leg 5). Every unhandled error becomes a sanitized JSON response — no
 * stack, no internal detail — carrying a correlation id that also goes to the response header and the
 * server log, so a 500 seen by a client can be traced to its logged cause. HttpExceptions keep their
 * intended status + message; anything else collapses to a generic 500 so internals never leak.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('UnhandledException');

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const request = ctx.getRequest<HttpRequestLike>();
    const response = ctx.getResponse<HttpResponseLike>();

    const correlationId = headerValue(request.headers['x-correlation-id']) ?? randomUUID();
    // The correlation id always travels on the response header, so a caller can quote it regardless of
    // the body shape and it ties back to the server log line below.
    response.setHeader('x-correlation-id', correlationId);

    if (exception instanceof HttpException) {
      // Controller-authored HttpExceptions are already safe + intentional (they carry contract shapes
      // like `{ code: 'BATCH_NOT_FOUND' }`). Reproduce Nest's default body verbatim so no route's error
      // contract changes — we only add the header + a log line.
      const status = exception.getStatus();
      this.logger.warn(`${request.method} ${request.url} → ${status} [${correlationId}] ${exception.message}`);
      response.status(status).json(exception.getResponse());
      return;
    }

    // HTTP-layer errors thrown below Nest (http-errors family: body-parser's 413 PayloadTooLarge /
    // 400 entity.parse.failed, …) carry a numeric status + an `expose` flag. Honor the status so an
    // oversized body is a clean 413, not a mislabeled 500; use the library message only when the
    // library itself marks it exposable (expose = status < 500 per http-errors).
    const httpStatus = httpErrorStatus(exception);
    if (httpStatus !== undefined) {
      const exposed =
        (exception as { expose?: boolean }).expose === true && exception instanceof Error
          ? exception.message
          : 'Request rejected';
      this.logger.warn(`${request.method} ${request.url} → ${httpStatus} [${correlationId}] ${exposed}`);
      response.status(httpStatus).json({ statusCode: httpStatus, message: exposed, correlationId });
      return;
    }

    // Unknown error: log the full cause (with stack) server-side, return a generic sanitized 500 so no
    // internal detail — DB errors, stack frames — can ever reach the client.
    const detail = exception instanceof Error ? (exception.stack ?? exception.message) : String(exception);
    this.logger.error(`${request.method} ${request.url} → 500 [${correlationId}] ${detail}`);
    response.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      message: 'Internal server error',
      correlationId,
      path: request.url,
      timestamp: new Date().toISOString(),
    });
  }
}

/** 4xx status of an http-errors-style client error (`status`/`statusCode` field); undefined otherwise. */
function httpErrorStatus(exception: unknown): number | undefined {
  if (typeof exception !== 'object' || exception === null) return undefined;
  const raw =
    (exception as { status?: unknown }).status ?? (exception as { statusCode?: unknown }).statusCode;
  return typeof raw === 'number' && Number.isInteger(raw) && raw >= 400 && raw < 500 ? raw : undefined;
}

/** First value of a header that may arrive as a string or string[]; undefined when absent/blank. */
function headerValue(raw: string | string[] | undefined): string | undefined {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value && value.trim() ? value : undefined;
}
