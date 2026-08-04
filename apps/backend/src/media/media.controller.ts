import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  StreamableFile,
  UploadedFile,
  UseFilters,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { MEDIA_SLOTS_BY_KIND, type MediaKind, type MediaSlot } from '@fsm/shared';
import { AccessTokenClaims } from '../auth/token.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { AuthGuard } from '../common/guards/auth.guard';
import { RoleGuard } from '../common/guards/role.guard';
import { MediaService } from './media.service';
import { MulterErrorFilter } from './multer-error.filter';

const VALID_KINDS: ReadonlySet<string> = new Set(['TROUBLESHOOT', 'VOUCHER', 'INSTALL']);
// PRD:311 mandates client-side compression to a few hundred KB; this is a server-side backstop,
// not the target size.
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const VALID_CONTENT_TYPES: ReadonlySet<string> = new Set(['image/jpeg', 'image/png', 'image/webp']);
const REVIEW_ROLES = ['ZONAL_MANAGER', 'CENTRAL_SERVICE_MANAGER', 'OPERATIONS_HEAD'];

interface UploadBody {
  kind?: string;
  slot?: string;
}

/**
 * Media Upload API (Issue 81, D-12). Turns a captured photo into an opaque `photoRef` — this
 * route's `mediaId` — that the troubleshoot/voucher/install forms accept unchanged. Storage is
 * Postgres for the pilot, fully hidden behind this seam.
 */
@Controller('media')
@UseGuards(AuthGuard, RoleGuard)
export class MediaController {
  constructor(private readonly media: MediaService) {}

  @Post('upload')
  @HttpCode(201)
  @Roles('SERVICE_ENGINEER')
  @UseFilters(MulterErrorFilter)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_FILE_BYTES } }))
  async upload(
    @CurrentUser() user: AccessTokenClaims,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body() body: UploadBody,
  ) {
    if (!body.kind || !VALID_KINDS.has(body.kind)) {
      throw new BadRequestException({ code: 'INVALID_KIND' });
    }
    const kind = body.kind as MediaKind;
    const allowedSlots = MEDIA_SLOTS_BY_KIND[kind];
    if (!body.slot || !allowedSlots.includes(body.slot as MediaSlot)) {
      throw new BadRequestException({ code: 'INVALID_SLOT', kind, allowed: allowedSlots });
    }
    if (!file) {
      throw new BadRequestException({ code: 'FILE_REQUIRED' });
    }
    if (!VALID_CONTENT_TYPES.has(file.mimetype)) {
      throw new BadRequestException({ code: 'INVALID_CONTENT_TYPE' });
    }

    const slot = body.slot as MediaSlot;
    const created = await this.media.create({
      seId: user.user_id,
      kind,
      slot,
      contentType: file.mimetype,
      bytes: file.buffer,
    });
    return { photoRef: created.mediaId, kind, slot };
  }

  @Get(':id')
  @Roles('SERVICE_ENGINEER', ...REVIEW_ROLES)
  async read(@CurrentUser() user: AccessTokenClaims, @Param('id') id: string): Promise<StreamableFile> {
    const found = await this.media.find(id);
    if (!found) throw new NotFoundException({ code: 'MEDIA_NOT_FOUND' });
    const isOwner = found.seId === user.user_id;
    const isReviewer = REVIEW_ROLES.includes(user.role);
    if (!isOwner && !isReviewer) throw new ForbiddenException({ code: 'MEDIA_FORBIDDEN' });
    return new StreamableFile(found.bytes, { type: found.contentType });
  }
}
