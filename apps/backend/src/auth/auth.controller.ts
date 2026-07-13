import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import type { LoginRequest, LoginResponse } from '@fsm/shared';
import { Public } from '../common/decorators/public.decorator';
import { AuthService } from './auth.service';

interface RefreshBody {
  refreshToken: string;
}

/** Tokenless by definition — the routes that *mint* tokens (@Public opts out of the global guard, #99). */
@Controller('auth')
@Public()
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('login')
  @HttpCode(200)
  login(@Body() body: LoginRequest): Promise<LoginResponse> {
    return this.auth.login(body.email, body.password);
  }

  @Post('refresh')
  @HttpCode(200)
  refresh(@Body() body: RefreshBody): Promise<LoginResponse> {
    return this.auth.refresh(body.refreshToken);
  }
}











