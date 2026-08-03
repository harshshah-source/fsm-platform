import { Controller, Get, UseGuards } from '@nestjs/common';
import type { Role, SessionView } from '@fsm/shared';
import { CurrentActor } from '../common/decorators/current-actor.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { RequestActor } from '../common/request-actor';
import { AccessTokenClaims } from '../auth/token.service';
import { AuthGuard } from '../common/guards/auth.guard';
import { MeProfileService } from './me-profile.service';

@Controller('me')
@UseGuards(AuthGuard)
export class MeController {
  constructor(private readonly profile: MeProfileService) {}

  @Get()
  async me(
    @CurrentUser() user: AccessTokenClaims,
    @CurrentActor() actor: RequestActor,
  ): Promise<SessionView> {
    // role/acted_as_role originate from our own signed tokens, so they are trusted Roles.
    const session: SessionView = {
      user_id: user.user_id,
      role: user.role as Role,
      zone_id: user.zone_id,
      acted_as_role: actor.actedAsRole as Role | null,
    };

    // #161 — SE profile enrichment, additive only: no `profile` key at all for other roles, and none
    // for an SE with no EngineerMaster row (never errors the base session read over an enrichment gap).
    if (user.role === 'SERVICE_ENGINEER') {
      const seProfile = await this.profile.getSeProfile(user.user_id);
      if (seProfile) session.profile = seProfile;
    }

    return session;
  }
}
