import { Injectable } from '@nestjs/common';
import type { MediaKind, MediaSlot } from '@fsm/shared';
import { PrismaService } from '../prisma/prisma.service';

export interface CreateMediaInput {
  seId: string;
  kind: MediaKind;
  slot: MediaSlot;
  contentType: string;
  bytes: Buffer;
}

export interface StoredMedia {
  mediaId: string;
  seId: string;
  contentType: string;
  bytes: Buffer;
}

/**
 * Issue 81 (D-12) — the Media Upload API's storage seam. Postgres-backed for the pilot; the
 * `photoRef` a caller receives is this row's `mediaId`, opaque and carrying no storage detail.
 */
@Injectable()
export class MediaService {
  constructor(private readonly prisma: PrismaService) {}

  async create(input: CreateMediaInput): Promise<{ mediaId: string }> {
    const row = await this.prisma.mediaObject.create({
      data: {
        seId: input.seId,
        kind: input.kind,
        slot: input.slot,
        contentType: input.contentType,
        sizeBytes: input.bytes.length,
        bytes: new Uint8Array(input.bytes),
      },
      select: { mediaId: true },
    });
    return { mediaId: row.mediaId };
  }

  async find(mediaId: string): Promise<StoredMedia | null> {
    const row = await this.prisma.mediaObject.findUnique({
      where: { mediaId },
      select: { mediaId: true, seId: true, contentType: true, bytes: true },
    });
    if (!row) return null;
    return { mediaId: row.mediaId, seId: row.seId, contentType: row.contentType, bytes: Buffer.from(row.bytes) };
  }
}
