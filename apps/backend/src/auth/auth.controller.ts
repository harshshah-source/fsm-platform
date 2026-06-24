import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import type { LoginRequest, LoginResponse } from '@fsm/shared';
import { AuthService } from './auth.service';

interface RefreshBody {
  refreshToken: string;
}

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('login')
  @HttpCode(200)
  login(@Body() body: LoginRequest): LoginResponse {
    return this.auth.login(body.email, body.password);
  }

  @Post('refresh')
  @HttpCode(200)
  refresh(@Body() body: RefreshBody): LoginResponse {
    return this.auth.refresh(body.refreshToken);
  }
}
