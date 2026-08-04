import { type ArgumentsHost, Catch, type ExceptionFilter, PayloadTooLargeException } from '@nestjs/common';
import { MulterError } from 'multer';

interface HttpResponseLike {
  status(code: number): { json(body: unknown): unknown };
}

/**
 * Issue 81 — `FileInterceptor` translates a multer `LIMIT_FILE_SIZE` error into Nest's own
 * `PayloadTooLargeException` (413) before any raw `MulterError` reaches a filter, and the global
 * `AllExceptionsFilter` would reproduce that 413 verbatim. This issue's AC requires `FILE_TOO_LARGE`
 * as a 400 like every other validation error, so both shapes are caught here, scoped locally to the
 * upload route only.
 */
@Catch(PayloadTooLargeException, MulterError)
export class MulterErrorFilter implements ExceptionFilter {
  catch(exception: PayloadTooLargeException | MulterError, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<HttpResponseLike>();
    const code =
      exception instanceof PayloadTooLargeException || exception.code === 'LIMIT_FILE_SIZE'
        ? 'FILE_TOO_LARGE'
        : 'UPLOAD_ERROR';
    response.status(400).json({ code });
  }
}
