import { Controller, Get, UseGuards } from '@nestjs/common';
import type { Role, SessionView } from '@fsm/shared';
import { CurrentActor } from '../common/decorators/current-actor.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { RequestActor } from '../common/request-actor';
import { AccessTokenClaims } from '../auth/token.service';
import { AuthGuard } from '../common/guards/auth.guard';

@Controller('me')
@UseGuards(AuthGuard)
export class MeController {
  @Get()
  me(
    @CurrentUser() user: AccessTokenClaims,
    @CurrentActor() actor: RequestActor,
  ): SessionView {
    // role/acted_as_role originate from our own signed tokens, so they are trusted Roles.
    return {
      user_id: user.user_id,
      role: user.role as Role,
      zone_id: user.zone_id,
      acted_as_role: actor.actedAsRole as Role | null,
    };
  }
}
