import { Inject, Injectable } from '@nestjs/common';
import { WsException } from '@nestjs/websockets';
import { PrismaService } from '../prisma/prisma.service.js';
import { REDIS_CLIENT } from '../redis/redis.module.js';
import Redis from 'ioredis';
import { UpsertProfileDto } from './dto/upsert-profile.dto.js';
import { Profile } from '@prisma/client';

@Injectable()
export class ProfilesService {
  constructor(
    public prisma: PrismaService,
    @Inject(REDIS_CLIENT) private redis: Redis,
  ) {}

  async upsertProfile(dto: UpsertProfileDto): Promise<Profile> {
    return this.prisma.profile.upsert({
      where: { id: dto.id },
      create: {
        id: dto.id,
        appId: dto.appId,
        accountId: dto.accountId,
        displayName: dto.displayName,
        avatarUrl: dto.avatarUrl ?? null,
        age: dto.age ?? null,
        city: dto.city ?? null,
      },
      update: {
        displayName: dto.displayName,
        avatarUrl: dto.avatarUrl ?? null,
        ...(dto.appId ? { appId: dto.appId } : {}),
        ...(dto.accountId !== null ? { accountId: dto.accountId } : {}),
        ...(dto.age !== undefined ? { age: dto.age } : {}),
        ...(dto.city !== undefined ? { city: dto.city } : {}),
      },
    });
  }

  async assertOwnership(profileId: string, accountId: string, appId: string): Promise<Profile> {
    const profile = await this.prisma.profile.findFirst({
      where: { id: profileId, accountId, appId },
    });
    if (!profile) {
      throw new WsException('Profile not found or not owned by this account');
    }
    return profile;
  }

  private presenceKey(appId: string, profileId: string): string {
    return `presence:${appId}:${profileId}`;
  }

  private lastSeenKey(appId: string, profileId: string): string {
    return `presence:lastseen:${appId}:${profileId}`;
  }

  private manualOfflineKey(appId: string, profileId: string): string {
    return `presence:manual-offline:${appId}:${profileId}`;
  }

  async setManuallyOffline(appId: string, profileId: string): Promise<void> {
    await this.redis.set(this.manualOfflineKey(appId, profileId), '1', 'EX', 86400);
  }

  async clearManuallyOffline(appId: string, profileId: string): Promise<void> {
    await this.redis.del(this.manualOfflineKey(appId, profileId));
  }

  async isManuallyOffline(appId: string, profileId: string): Promise<boolean> {
    return (await this.redis.exists(this.manualOfflineKey(appId, profileId))) === 1;
  }

  async isEffectivelyOnline(appId: string, profileId: string): Promise<boolean> {
    const online = await this.isProfileOnline(appId, profileId);
    if (!online) return false;
    return !(await this.isManuallyOffline(appId, profileId));
  }

  async profileConnected(appId: string, profileId: string, socketId: string): Promise<void> {
    const key = this.presenceKey(appId, profileId);
    await this.redis.sadd(key, socketId);
    await this.redis.expire(key, 86400);
  }

  async profileDisconnected(appId: string, profileId: string, socketId: string): Promise<number> {
    const key = this.presenceKey(appId, profileId);
    await this.redis.srem(key, socketId);
    const remaining = await this.redis.scard(key);
    if (remaining === 0) {
      await this.redis.set(
        this.lastSeenKey(appId, profileId),
        new Date().toISOString(),
        'EX',
        2592000,
      );
    }
    return remaining;
  }

  async getProfileSockets(appId: string, profileId: string): Promise<string[]> {
    return this.redis.smembers(this.presenceKey(appId, profileId));
  }

  async isProfileOnline(appId: string, profileId: string): Promise<boolean> {
    const count = await this.redis.scard(this.presenceKey(appId, profileId));
    return count > 0;
  }

  async getProfileLastSeen(appId: string, profileId: string): Promise<string | null> {
    const online = await this.isEffectivelyOnline(appId, profileId);
    if (online) return null;
    return this.redis.get(this.lastSeenKey(appId, profileId));
  }

  async getBulkPresence(
    appId: string,
    profileIds: string[],
  ): Promise<Record<string, { isOnline: boolean; lastSeenAt: string | null }>> {
    if (profileIds.length === 0) return {};

    const pipeline = this.redis.pipeline();
    for (const id of profileIds) {
      pipeline.scard(this.presenceKey(appId, id));
      pipeline.exists(this.manualOfflineKey(appId, id));
      pipeline.get(this.lastSeenKey(appId, id));
    }

    const results = await pipeline.exec();
    if (!results) return {};

    const out: Record<string, { isOnline: boolean; lastSeenAt: string | null }> = {};
    for (let i = 0; i < profileIds.length; i++) {
      const base = i * 3;
      const socketCount = (results[base]?.[1] as number) ?? 0;
      const manualOffline = (results[base + 1]?.[1] as number) ?? 0;
      const lastSeen = (results[base + 2]?.[1] as string) ?? null;

      const isOnline = socketCount > 0 && manualOffline === 0;
      out[profileIds[i]] = {
        isOnline,
        lastSeenAt: isOnline ? null : lastSeen,
      };
    }
    return out;
  }

  async getProfilesByAccount(accountId: string, appId: string): Promise<Profile[]> {
    return this.prisma.profile.findMany({ where: { accountId, appId } });
  }

  async isAccountOnline(appId: string, accountId: string): Promise<boolean> {
    const profiles = await this.prisma.profile.findMany({
      where: { accountId, appId },
      select: { id: true },
    });
    if (profiles.length === 0) return false;

    const pipeline = this.redis.pipeline();
    for (const p of profiles) {
      pipeline.scard(this.presenceKey(appId, p.id));
    }
    const results = await pipeline.exec();
    if (!results) return false;

    return results.some(([, count]) => (count as number) > 0);
  }
}
