import { Injectable } from '@nestjs/common';
import { WsException } from '@nestjs/websockets';
import { PrismaService } from '../prisma/prisma.service.js';
import { ProfilesService } from '../profiles/profiles.service.js';
import { Conversation } from '@prisma/client';

export interface MessageWithSender {
  id: string;
  conversationId: string;
  sender: {
    profileId: string;
    displayName: string;
    avatarUrl: string | null;
  };
  content: string;
  type: string;
  sentAt: Date;
  reactions: ReactionGroup[];
}

export interface ReactionGroup {
  emoji: string;
  count: number;
  profileIds: string[];
}

export interface ConversationWithPreview {
  id: string;
  appId: string;
  type: string;
  createdAt: Date;
  updatedAt: Date;
  otherProfile: {
    profileId: string;
    displayName: string;
    avatarUrl: string | null;
    age: number | null;
    city: string | null;
    isOnline: boolean;
    lastSeenAt: string | null;
  };
  lastMessage: MessageWithSender | null;
  unreadCount: number;
  otherParticipantLastReadAt?: string | null;
}

@Injectable()
export class ConversationsService {
  constructor(
    public prisma: PrismaService,
    private profilesService: ProfilesService,
  ) {}

  async findOrCreateDirectConversation(
    appId: string,
    profileIdA: string,
    profileIdB: string,
  ): Promise<Conversation> {
    // Block conversations between profiles on the same account
    const [profileA, profileB] = await Promise.all([
      this.prisma.profile.findUnique({ where: { id: profileIdA }, select: { accountId: true } }),
      this.prisma.profile.findUnique({ where: { id: profileIdB }, select: { accountId: true } }),
    ]);
    if (profileA?.accountId && profileB?.accountId && profileA.accountId === profileB.accountId) {
      throw new WsException('Cannot start a conversation between profiles on the same account');
    }

    // Find existing direct conversation where both profiles participate
    const existing = await this.prisma.conversation.findFirst({
      where: {
        appId,
        type: 'DIRECT',
        AND: [
          { participants: { some: { profileId: profileIdA } } },
          { participants: { some: { profileId: profileIdB } } },
        ],
      },
      include: { participants: true },
    });

    if (existing && existing.participants.length === 2) {
      return existing;
    }

    return this.prisma.conversation.create({
      data: {
        appId,
        type: 'DIRECT',
        participants: {
          create: [{ profileId: profileIdA }, { profileId: profileIdB }],
        },
      },
    });
  }

  async getProfileConversations(appId: string, profileId: string): Promise<ConversationWithPreview[]> {
    const participants = await this.prisma.participant.findMany({
      where: { profileId, conversation: { appId } },
      include: {
        conversation: {
          include: {
            participants: { include: { profile: true } },
            messages: {
              where: { deletedAt: null },
              orderBy: { sentAt: 'desc' },
              take: 1,
            },
          },
        },
      },
      orderBy: { conversation: { updatedAt: 'desc' } },
    });

    const previews: ConversationWithPreview[] = [];

    for (const p of participants) {
      const conv = p.conversation;
      const otherParticipant = conv.participants.find(pp => pp.profileId !== profileId);
      if (!otherParticipant) continue;

      const otherProfile = otherParticipant.profile;
      const isOnline = await this.profilesService.isEffectivelyOnline(appId, otherProfile.id);
      const lastSeenAt = await this.profilesService.getProfileLastSeen(appId, otherProfile.id);

      const lastMsg = conv.messages[0] ?? null;
      const lastMessage = lastMsg ? await this.formatMessage(lastMsg) : null;
      const unreadCount = await this.getConversationUnreadCount(conv.id, profileId);

      previews.push({
        id: conv.id,
        appId: conv.appId,
        type: conv.type,
        createdAt: conv.createdAt,
        updatedAt: conv.updatedAt,
        otherProfile: {
          profileId: otherProfile.id,
          displayName: otherProfile.displayName,
          avatarUrl: otherProfile.avatarUrl,
          age: otherProfile.age,
          city: otherProfile.city,
          isOnline,
          lastSeenAt,
        },
        lastMessage,
        unreadCount,
      });
    }

    return previews;
  }

  async getSingleConversation(
    conversationId: string,
    profileId: string,
    appId: string,
  ): Promise<ConversationWithPreview | null> {
    const participant = await this.prisma.participant.findUnique({
      where: { profileId_conversationId: { profileId, conversationId } },
      include: {
        conversation: {
          include: {
            participants: { include: { profile: true } },
            messages: {
              where: { deletedAt: null },
              orderBy: { sentAt: 'desc' },
              take: 1,
            },
          },
        },
      },
    });

    if (!participant) return null;

    const conv = participant.conversation;
    const otherParticipant = conv.participants.find(pp => pp.profileId !== profileId);
    if (!otherParticipant) return null;

    const otherProfile = otherParticipant.profile;
    const isOnline = await this.profilesService.isEffectivelyOnline(appId, otherProfile.id);
    const lastSeenAt = await this.profilesService.getProfileLastSeen(appId, otherProfile.id);
    const lastMessage = conv.messages[0] ? await this.formatMessage(conv.messages[0]) : null;
    const unreadCount = await this.getConversationUnreadCount(conv.id, profileId);

    return {
      id: conv.id,
      appId: conv.appId,
      type: conv.type,
      createdAt: conv.createdAt,
      updatedAt: conv.updatedAt,
      otherProfile: {
        profileId: otherProfile.id,
        displayName: otherProfile.displayName,
        avatarUrl: otherProfile.avatarUrl,
        age: otherProfile.age,
        city: otherProfile.city,
        isOnline,
        lastSeenAt,
      },
      lastMessage,
      unreadCount,
      otherParticipantLastReadAt: otherParticipant.lastReadAt?.toISOString() ?? null,
    };
  }

  async assertParticipant(conversationId: string, profileId: string): Promise<void> {
    const p = await this.prisma.participant.findUnique({
      where: { profileId_conversationId: { profileId, conversationId } },
    });
    if (!p) {
      throw new WsException('Profile is not a participant of this conversation');
    }
  }

  async markAsRead(conversationId: string, profileId: string): Promise<void> {
    await this.prisma.participant.update({
      where: { profileId_conversationId: { profileId, conversationId } },
      data: { lastReadAt: new Date() },
    });
  }

  async getConversationUnreadCount(conversationId: string, profileId: string): Promise<number> {
    const participant = await this.prisma.participant.findUnique({
      where: { profileId_conversationId: { profileId, conversationId } },
    });
    if (!participant) return 0;

    return this.prisma.message.count({
      where: {
        conversationId,
        deletedAt: null,
        senderProfileId: { not: profileId },
        ...(participant.lastReadAt ? { sentAt: { gt: participant.lastReadAt } } : {}),
      },
    });
  }

  async getTotalUnreadCount(appId: string, profileId: string): Promise<number> {
    const participants = await this.prisma.participant.findMany({
      where: { profileId, conversation: { appId } },
    });

    let total = 0;
    for (const p of participants) {
      const count = await this.prisma.message.count({
        where: {
          conversationId: p.conversationId,
          deletedAt: null,
          senderProfileId: { not: profileId },
          ...(p.lastReadAt ? { sentAt: { gt: p.lastReadAt } } : {}),
        },
      });
      total += count;
    }
    return total;
  }

  async getTotalUnreadCountByAccount(appId: string, accountId: string): Promise<number> {
    const profiles = await this.prisma.profile.findMany({
      where: { accountId, appId },
      select: { id: true },
    });
    const profileIds = profiles.map((p) => p.id);
    if (profileIds.length === 0) return 0;

    const participants = await this.prisma.participant.findMany({
      where: { profileId: { in: profileIds }, conversation: { appId } },
    });

    let total = 0;
    for (const p of participants) {
      const count = await this.prisma.message.count({
        where: {
          conversationId: p.conversationId,
          deletedAt: null,
          senderProfileId: { not: p.profileId },
          ...(p.lastReadAt ? { sentAt: { gt: p.lastReadAt } } : {}),
        },
      });
      total += count;
    }
    return total;
  }

  async getConversationParticipants(conversationId: string) {
    return this.prisma.participant.findMany({
      where: { conversationId },
      include: { profile: true },
    });
  }

  async formatMessage(msg: any): Promise<MessageWithSender> {
    const senderProfile = await this.prisma.profile.findUnique({
      where: { id: msg.senderProfileId },
    });

    const reactions = await this.groupReactions(msg.id);

    return {
      id: msg.id,
      conversationId: msg.conversationId,
      sender: {
        profileId: msg.senderProfileId,
        displayName: senderProfile?.displayName ?? msg.senderProfileId,
        avatarUrl: senderProfile?.avatarUrl ?? null,
      },
      content: msg.content,
      type: msg.type,
      sentAt: msg.sentAt,
      reactions,
    };
  }

  async groupReactions(messageId: string): Promise<ReactionGroup[]> {
    const reactions = await this.prisma.messageReaction.findMany({
      where: { messageId },
    });

    const grouped: Record<string, ReactionGroup> = {};
    for (const r of reactions) {
      if (!grouped[r.emoji]) {
        grouped[r.emoji] = { emoji: r.emoji, count: 0, profileIds: [] };
      }
      grouped[r.emoji].count++;
      grouped[r.emoji].profileIds.push(r.profileId);
    }
    return Object.values(grouped);
  }
}
