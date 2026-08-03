import { randomUUID } from 'node:crypto';
import { Body, Controller, Headers, HttpCode, Post } from '@nestjs/common';
import type { LoginRequest, LoginResponse } from '@fsm/shared';
import { Public } from '../common/decorators/public.decorator';
import { AuthService } from './auth.service';

interface RefreshBody {
  refreshToken: string;
}

interface LogoutBody {
  refreshToken: string;
}

/** Tokenless by definition — the routes that mint or end tokens (@Public opts out of the global guard, #99). */
@Controller('auth')
@Public()
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('login')
  @HttpCode(200)
  login(
    @Body() body: LoginRequest,
    @Headers('x-device-id') deviceId?: string,
  ): Promise<LoginResponse> {
    // #91 S3: no client sends a stable X-Device-Id yet (mobile's leg is tracked on #54). Falling back
    // to a random per-login id keeps the NOT NULL `device_id` column satisfied; it means one-active-
    // device enforcement only meaningfully activates once a client sends a real stable id — accepted,
    // documented limitation, not a bug to chase in this slice.
    return this.auth.login(body.email, body.password, deviceId ?? randomUUID());
  }

  @Post('refresh')
  @HttpCode(200)
  refresh(
    @Body() body: RefreshBody,
    @Headers('x-device-id') deviceId?: string,
  ): Promise<LoginResponse> {
    return this.auth.refresh(body.refreshToken, deviceId);
  }

  @Post('logout')
  @HttpCode(200)
  async logout(@Body() body: LogoutBody): Promise<{ success: true }> {
    await this.auth.logout(body.refreshToken);
    return { success: true };
  }
}
