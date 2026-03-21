import { Inject, Injectable } from '@nestjs/common';
import Redis from 'ioredis';
import { REDIS_CLIENT } from '../redis/redis.module.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ProfileCategory } from '@prisma/client';

@Injectable()
export class OperatorService {
  private profileToOperators = new Map<string, Set<string>>();
  private operatorToProfiles = new Map<string, Set<string>>();

  constructor(
    @Inject(REDIS_CLIENT) private redis: Redis,
    private prisma: PrismaService,
  ) {}

  registerOperator(operatorId: string, managedProfileIds: string[]): void {
    this.operatorToProfiles.set(operatorId, new Set(managedProfileIds));
    for (const profileId of managedProfileIds) {
      let operators = this.profileToOperators.get(profileId);
      if (!operators) {
        operators = new Set();
        this.profileToOperators.set(profileId, operators);
      }
      operators.add(operatorId);
    }
  }

  unregisterOperator(operatorId: string): void {
    const profiles = this.operatorToProfiles.get(operatorId);
    if (profiles) {
      for (const profileId of profiles) {
        const operators = this.profileToOperators.get(profileId);
        if (operators) {
          operators.delete(operatorId);
          if (operators.size === 0) {
            this.profileToOperators.delete(profileId);
          }
        }
      }
    }
    this.operatorToProfiles.delete(operatorId);
  }

  isManagedProfile(profileId: string): boolean {
    return (
      this.profileToOperators.has(profileId) &&
      this.profileToOperators.get(profileId)!.size > 0
    );
  }

  getOperatorsForProfile(profileId: string): string[] {
    return [...(this.profileToOperators.get(profileId) ?? [])];
  }

  getManagedProfileIds(operatorId: string): string[] {
    return [...(this.operatorToProfiles.get(operatorId) ?? [])];
  }

  async setProfileRanking(profileId: string, rating: number, category: string, operatorId: string) {
    if (rating < 1 || rating > 5) throw new Error('Rating must be 1-5');
    return this.prisma.profileRanking.upsert({
      where: { profileId },
      create: { profileId, rating, category: category as ProfileCategory, updatedBy: operatorId },
      update: { rating, category: category as ProfileCategory, updatedBy: operatorId },
    });
  }

  async getProfileRanking(profileId: string) {
    return this.prisma.profileRanking.findUnique({ where: { profileId } });
  }

  async saveProfileNote(profileId: string, operatorId: string, content: string) {
    // Upsert: one note per operator per profile
    const existing = await this.prisma.profileNote.findFirst({
      where: { profileId, operatorId },
    });
    if (existing) {
      return this.prisma.profileNote.update({
        where: { id: existing.id },
        data: { content },
      });
    }
    return this.prisma.profileNote.create({
      data: { profileId, operatorId, content },
    });
  }

  async getProfileNotes(profileId: string) {
    return this.prisma.profileNote.findMany({
      where: { profileId },
      orderBy: { updatedAt: 'desc' },
    });
  }

  async getDailyReplyCount(operatorId: string): Promise<number> {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    return this.prisma.message.count({
      where: {
        sentByOperatorId: operatorId,
        sentAt: { gte: startOfDay },
      },
    });
  }

  async recordResponseTime(conversationId: string, operatorId: string, responseTimeMs: number) {
    return this.prisma.operatorMetric.create({
      data: { conversationId, operatorId, responseTimeMs },
    });
  }
}
