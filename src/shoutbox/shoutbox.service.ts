import { Injectable, Inject } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import Redis from 'ioredis';
import { REDIS_CLIENT } from '../redis/redis.module.js';

@Injectable()
export class ShoutboxService {
  constructor(
    private prisma: PrismaService,
    @Inject(REDIS_CLIENT) private redis: Redis,
  ) {}

  async checkRateLimit(profileId: string): Promise<boolean> {
    const key = `ratelimit:shoutbox:${profileId}`;
    const result = await this.redis.set(key, '1', 'EX', 2, 'NX');
    return result === 'OK';
  }

  async createMessage(appId: string, senderProfileId: string, content: string) {
    const message = await this.prisma.shoutboxMessage.create({
      data: { appId, senderProfileId, content },
    });

    const sender = await this.prisma.profile.findUnique({
      where: { id: senderProfileId },
      select: { id: true, displayName: true, avatarUrl: true, age: true },
    });

    return {
      id: message.id,
      appId: message.appId,
      senderProfileId: message.senderProfileId,
      content: message.content,
      sentAt: message.sentAt.toISOString(),
      sender: sender
        ? {
            id: sender.id,
            displayName: sender.displayName,
            avatarUrl: sender.avatarUrl,
            age: sender.age,
          }
        : null,
    };
  }

  async getMessages(limit: number = 30, cursor?: string) {
    let cursorCondition = {};

    if (cursor) {
      const cursorMsg = await this.prisma.shoutboxMessage.findUnique({
        where: { id: cursor },
      });
      if (cursorMsg) {
        cursorCondition = { sentAt: { lt: cursorMsg.sentAt } };
      }
    }

    const messages = await this.prisma.shoutboxMessage.findMany({
      where: { deletedAt: null, ...cursorCondition },
      orderBy: { sentAt: 'desc' },
      take: limit + 1,
    });

    const hasMore = messages.length > limit;
    const page = hasMore ? messages.slice(0, limit) : messages;
    const nextCursor = hasMore ? page[page.length - 1].id : null;

    const profileIds = [...new Set(page.map((m) => m.senderProfileId))];
    const profiles = await this.prisma.profile.findMany({
      where: { id: { in: profileIds } },
      select: { id: true, displayName: true, avatarUrl: true, age: true },
    });
    const profileMap = new Map(profiles.map((p) => [p.id, p]));

    const formatted = page.map((m) => ({
      id: m.id,
      appId: m.appId,
      senderProfileId: m.senderProfileId,
      content: m.content,
      sentAt: m.sentAt.toISOString(),
      sender: profileMap.get(m.senderProfileId) ?? null,
    }));

    return { messages: formatted, nextCursor };
  }

  async softDelete(id: string) {
    return this.prisma.shoutboxMessage.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
  }
}
