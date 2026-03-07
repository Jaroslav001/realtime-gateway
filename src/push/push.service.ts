import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service.js';
import * as webPush from 'web-push';

@Injectable()
export class PushService {
  private readonly logger = new Logger(PushService.name);

  constructor(
    private prisma: PrismaService,
    private config: ConfigService,
  ) {
    const publicKey = this.config.get<string>('vapid.publicKey');
    const privateKey = this.config.get<string>('vapid.privateKey');
    const subject = this.config.get<string>('vapid.subject');

    if (publicKey && privateKey && subject) {
      webPush.setVapidDetails(subject, publicKey, privateKey);
    } else {
      this.logger.warn('VAPID keys not configured — web push disabled');
    }
  }

  async upsertSubscription(
    accountId: string,
    endpoint: string,
    p256dh: string,
    auth: string,
    userAgent?: string,
  ) {
    return this.prisma.pushSubscription.upsert({
      where: { endpoint },
      create: { accountId, endpoint, p256dh, auth, userAgent },
      update: { accountId, p256dh, auth, userAgent },
    });
  }

  async removeSubscription(endpoint: string) {
    return this.prisma.pushSubscription.deleteMany({ where: { endpoint } });
  }

  async sendToAccount(
    accountId: string,
    payload: {
      title: string;
      body: string;
      icon?: string;
      conversationId: string;
      targetProfileId: string;
      unreadCount?: number;
    },
  ) {
    const subscriptions = await this.prisma.pushSubscription.findMany({
      where: { accountId },
    });

    this.logger.log(`sendToAccount: account=${accountId} subscriptions=${subscriptions.length}`);
    if (subscriptions.length === 0) return;

    const jsonPayload = JSON.stringify(payload);

    const results = await Promise.allSettled(
      subscriptions.map((sub) =>
        webPush.sendNotification(
          {
            endpoint: sub.endpoint,
            keys: { p256dh: sub.p256dh, auth: sub.auth },
          },
          jsonPayload,
        ),
      ),
    );

    // Clean up expired/invalid subscriptions
    const toDelete: string[] = [];
    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (result.status === 'rejected') {
        const statusCode = (result.reason as any)?.statusCode;
        if (statusCode === 404 || statusCode === 410) {
          toDelete.push(subscriptions[i].id);
        } else {
          this.logger.error(
            `Push failed for ${subscriptions[i].endpoint}: ${result.reason}`,
          );
        }
      }
    }

    if (toDelete.length > 0) {
      await this.prisma.pushSubscription.deleteMany({
        where: { id: { in: toDelete } },
      });
    }
  }

  async sendToAccountFiltered(
    accountId: string,
    payload: {
      title: string;
      body: string;
      icon?: string;
      conversationId: string;
      targetProfileId: string;
      unreadCount?: number;
    },
    suppressedEndpoints: Set<string>,
  ) {
    const subscriptions = await this.prisma.pushSubscription.findMany({
      where: { accountId },
    });

    const toSend = subscriptions.filter((s) => !suppressedEndpoints.has(s.endpoint));
    this.logger.log(
      `sendToAccountFiltered: account=${accountId} total=${subscriptions.length} suppressed=${suppressedEndpoints.size} sending=${toSend.length}`,
    );
    if (toSend.length === 0) return;

    const jsonPayload = JSON.stringify(payload);

    const results = await Promise.allSettled(
      toSend.map((sub) =>
        webPush.sendNotification(
          {
            endpoint: sub.endpoint,
            keys: { p256dh: sub.p256dh, auth: sub.auth },
          },
          jsonPayload,
        ),
      ),
    );

    const toDelete: string[] = [];
    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (result.status === 'rejected') {
        const statusCode = (result.reason as any)?.statusCode;
        if (statusCode === 404 || statusCode === 410) {
          toDelete.push(toSend[i].id);
        } else {
          this.logger.error(
            `Push failed for ${toSend[i].endpoint}: ${result.reason}`,
          );
        }
      }
    }

    if (toDelete.length > 0) {
      await this.prisma.pushSubscription.deleteMany({
        where: { id: { in: toDelete } },
      });
    }
  }
}
