import { Controller, Get, Headers, UseGuards } from '@nestjs/common';
import type { Role, SessionView } from '@fsm/shared';
import { resolveActingContext } from '../auth/acting-context';
import { AccessTokenClaims } from '../auth/token.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthGuard } from '../common/guards/auth.guard';

@Controller('me')
@UseGuards(AuthGuard)
export class MeController {
  @Get()
  me(
    @CurrentUser() user: AccessTokenClaims,
    @Headers('x-acting-as-zone') actingZone?: string,
  ): SessionView {
    const acting = resolveActingContext(user, actingZone);
    // role/acted_as_role originate from our own signed tokens, so they are trusted Roles.
    return {
      user_id: user.user_id,
      role: user.role as Role,
      zone_id: user.zone_id,
      acted_as_role: acting.actedAsRole as Role | null,
    };
  }
}
