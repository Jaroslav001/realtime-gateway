import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  WsException,
} from '@nestjs/websockets';
import { Inject, Logger } from '@nestjs/common';
import { Namespace, Socket } from 'socket.io';
import { OnEvent } from '@nestjs/event-emitter';
import { EventEmitter2 } from '@nestjs/event-emitter';
import Redis from 'ioredis';
import { OperatorService } from './operator.service.js';
import { EventRelayService } from '../event-relay/event-relay.service.js';
import { ChatService } from '../chat/chat.service.js';
import { ConversationsService, ConversationWithPreview } from '../conversations/conversations.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ProfilesService } from '../profiles/profiles.service.js';
import { REDIS_CLIENT } from '../redis/redis.module.js';
import {
  CHAT_MESSAGE_CREATED,
  CHAT_TYPING_UPDATE,
  OPERATOR_MESSAGE_SENT,
  OPERATOR_TYPING_UPDATE,
  ChatMessageCreatedEvent,
  ChatTypingEvent,
} from './operator-events.js';

@WebSocketGateway({
  namespace: '/operator',
  cors: {
    origin: (process.env.CORS_ORIGINS || '*').split(','),
    credentials: true,
  },
})
export class OperatorGateway
  implements OnGatewayConnection, OnGatewayDisconnect, OnGatewayInit
{
  @WebSocketServer()
  server: Namespace;

  private readonly logger = new Logger(OperatorGateway.name);

  constructor(
    private eventRelay: EventRelayService,
    private operatorService: OperatorService,
    private chatService: ChatService,
    private conversationsService: ConversationsService,
    private prisma: PrismaService,
    private profilesService: ProfilesService,
    private eventEmitter: EventEmitter2,
    @Inject(REDIS_CLIENT) private redis: Redis,
  ) {}

  afterInit(server: Namespace) {
    this.eventRelay.setServer(server, 'operator');
  }

  async handleConnection(client: Socket) {
    try {
      const rawToken =
        client.handshake?.auth?.token ||
        client.handshake?.headers?.authorization;

      if (!rawToken) {
        client.disconnect();
        return;
      }

      const token = rawToken.replace('Bearer ', '');
      const parts = token.split('.');
      if (parts.length !== 3) {
        client.disconnect();
        return;
      }

      const payloadJson = Buffer.from(parts[1], 'base64').toString('utf8');
      const payload = JSON.parse(payloadJson);

      if (payload.type !== 'operator') {
        client.emit('error', { message: 'Invalid token type' });
        client.disconnect();
        return;
      }

      const operatorId = String(payload.operator_id ?? payload.sub);
      const appId = String(payload.app_id);
      const managedProfileIds = (payload.managed_profile_ids ?? []).map(String);

      client.data.operator = { operatorId, appId, managedProfileIds };

      this.operatorService.registerOperator(operatorId, managedProfileIds);

      for (const profileId of managedProfileIds) {
        client.join('op:profile:' + profileId);
      }

      await this.redis.set(
        'operator-presence:' + operatorId,
        '1',
        'EX',
        86400,
      );

      client.emit('connected', { operatorId, managedProfileIds });

      // Emit server-side daily reply count
      const dailyCount = await this.operatorService.getDailyReplyCount(operatorId);
      client.emit('operator:daily-count', { count: dailyCount });

      this.logger.log(
        `Operator ${operatorId} connected, managing ${managedProfileIds.length} profiles`,
      );

      // NOTE: Do NOT call profileConnected/profileDisconnected (GW-07, presence isolation)
    } catch (err) {
      this.logger.error('Operator connection failed', (err as Error).message);
      client.emit('error', {
        message: (err as Error).message || 'Connection failed',
      });
      client.disconnect();
    }
  }

  async handleDisconnect(client: Socket) {
    if (!client.data?.operator) return;

    const { operatorId } = client.data.operator;
    this.operatorService.unregisterOperator(operatorId);
    await this.redis.del('operator-presence:' + operatorId);

    this.logger.log(`Operator ${operatorId} disconnected`);
  }

  @SubscribeMessage('operator:conversations:list')
  async handleConversationsList(
    @ConnectedSocket() client: Socket,
  ) {
    try {
      const { appId, managedProfileIds } = client.data.operator;

      // Aggregate conversations across all managed profiles
      const allConversations: (ConversationWithPreview & { managedProfileId: string })[] = [];
      const seenConversationIds = new Set<string>();

      for (const profileId of managedProfileIds) {
        const conversations = await this.conversationsService.getProfileConversations(appId, profileId);
        for (const conv of conversations) {
          if (!seenConversationIds.has(conv.id)) {
            seenConversationIds.add(conv.id);
            allConversations.push({
              ...conv,
              managedProfileId: profileId,
              createdAt: conv.createdAt instanceof Date ? conv.createdAt : new Date(conv.createdAt),
              updatedAt: conv.updatedAt instanceof Date ? conv.updatedAt : new Date(conv.updatedAt),
            });
          }
        }
      }

      // Sort by updatedAt descending (most recent first)
      allConversations.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());

      // Serialize dates to ISO strings for the client
      const serialized = allConversations.map(c => ({
        ...c,
        createdAt: c.createdAt.toISOString(),
        updatedAt: c.updatedAt.toISOString(),
        lastMessage: c.lastMessage ? {
          ...c.lastMessage,
          sentAt: c.lastMessage.sentAt instanceof Date
            ? c.lastMessage.sentAt.toISOString()
            : c.lastMessage.sentAt,
        } : null,
      }));

      client.emit('operator:conversations', serialized);
    } catch (err) {
      this.emitError(client, 'operator:conversations:list', err);
    }
  }

  @SubscribeMessage('operator:message:send')
  async handleOperatorMessageSend(
    @ConnectedSocket() client: Socket,
    @MessageBody()
    payload: {
      managedProfileId: string;
      recipientProfileId: string;
      content: string;
    },
  ) {
    try {
      const { operatorId, managedProfileIds, appId } = client.data.operator;

      if (!managedProfileIds.includes(payload.managedProfileId)) {
        throw new WsException('Not assigned to this profile');
      }

      const trimmed = payload.content?.trim();
      if (!trimmed) {
        throw new WsException('Message content cannot be empty');
      }

      const conversation =
        await this.conversationsService.findOrCreateDirectConversation(
          appId,
          payload.managedProfileId,
          payload.recipientProfileId,
        );

      const message = await this.chatService.saveMessage(
        conversation.id,
        payload.managedProfileId,
        trimmed,
      );

      // Set sentByOperatorId for audit
      await this.prisma.message.update({
        where: { id: message.id },
        data: { sentByOperatorId: operatorId },
      });

      // Mark as read for managed profile (prevent unread inflation)
      await this.conversationsService.markAsRead(
        conversation.id,
        payload.managedProfileId,
      );

      // Response time tracking: check if this is first operator reply since last inbound
      try {
        const lastInbound = await this.prisma.message.findFirst({
          where: {
            conversationId: conversation.id,
            senderProfileId: { not: payload.managedProfileId },
            sentByOperatorId: null,
          },
          orderBy: { sentAt: 'desc' },
          select: { sentAt: true },
        });

        if (lastInbound) {
          // Check no operator reply exists after that inbound message
          const operatorReplyAfter = await this.prisma.message.count({
            where: {
              conversationId: conversation.id,
              sentByOperatorId: { not: null },
              sentAt: { gt: lastInbound.sentAt },
              id: { not: message.id }, // exclude current message
            },
          });

          if (operatorReplyAfter === 0) {
            const responseTimeMs = message.sentAt.getTime() - lastInbound.sentAt.getTime();
            await this.operatorService.recordResponseTime(conversation.id, operatorId, responseTimeMs);
            this.logger.log(`Response time recorded: ${responseTimeMs}ms for conversation ${conversation.id}`);
          }
        }
      } catch (rtErr) {
        this.logger.warn('Failed to record response time', (rtErr as Error).message);
      }

      const msgPayload = { ...message, sentAt: message.sentAt.toISOString() };

      // Confirm to operator
      client.emit('operator:message:sent', msgPayload);

      // Cross-namespace relay for user delivery + push
      this.eventEmitter.emit(OPERATOR_MESSAGE_SENT, {
        conversationId: conversation.id,
        senderProfileId: payload.managedProfileId,
        recipientProfileIds: [payload.recipientProfileId],
        message: msgPayload,
        source: 'operator',
        sentByOperatorId: operatorId,
      } as ChatMessageCreatedEvent);
    } catch (err) {
      this.emitError(client, 'operator:message:send', err);
    }
  }

  @SubscribeMessage('operator:typing:start')
  async handleOperatorTypingStart(
    @ConnectedSocket() client: Socket,
    @MessageBody()
    payload: { managedProfileId: string; conversationId: string },
  ) {
    await this.handleOperatorTyping(client, payload, true);
  }

  @SubscribeMessage('operator:typing:stop')
  async handleOperatorTypingStop(
    @ConnectedSocket() client: Socket,
    @MessageBody()
    payload: { managedProfileId: string; conversationId: string },
  ) {
    await this.handleOperatorTyping(client, payload, false);
  }

  private async handleOperatorTyping(
    client: Socket,
    payload: { managedProfileId: string; conversationId: string },
    isTyping: boolean,
  ) {
    try {
      const { managedProfileIds } = client.data.operator;

      if (!managedProfileIds.includes(payload.managedProfileId)) {
        throw new WsException('Not assigned to this profile');
      }

      const participants =
        await this.conversationsService.getConversationParticipants(
          payload.conversationId,
        );

      // Only target OTHER participants, never the managed profile (GW-08)
      const otherParticipants = participants.filter(
        (p) => p.profileId !== payload.managedProfileId,
      );

      this.eventEmitter.emit(OPERATOR_TYPING_UPDATE, {
        conversationId: payload.conversationId,
        profileId: payload.managedProfileId,
        isTyping,
        source: 'operator',
        targetProfileIds: otherParticipants.map((p) => p.profileId),
      } as ChatTypingEvent);
    } catch (err) {
      this.emitError(
        client,
        isTyping ? 'operator:typing:start' : 'operator:typing:stop',
        err,
      );
    }
  }

  @SubscribeMessage('operator:message:history')
  async handleMessageHistory(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: { managedProfileId: string; conversationId: string; limit?: number; cursor?: string },
  ) {
    try {
      const { managedProfileIds } = client.data.operator;

      if (!managedProfileIds.includes(payload.managedProfileId)) {
        throw new WsException('Not assigned to this profile');
      }

      // Verify managed profile is participant (not assertOwnership - operators don't own profiles)
      await this.conversationsService.assertParticipant(payload.conversationId, payload.managedProfileId);

      const result = await this.chatService.getMessages(
        payload.conversationId,
        payload.limit ?? 50,
        payload.cursor,
      );

      client.emit('operator:message:history', {
        conversationId: payload.conversationId,
        messages: result.messages.map(m => ({
          ...m,
          sentAt: m.sentAt instanceof Date ? m.sentAt.toISOString() : m.sentAt,
        })),
        nextCursor: result.nextCursor,
      });
    } catch (err) {
      this.emitError(client, 'operator:message:history', err);
    }
  }

  @SubscribeMessage('operator:mark-read')
  async handleMarkRead(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: { managedProfileId: string; conversationId: string },
  ) {
    try {
      const { managedProfileIds } = client.data.operator;

      if (!managedProfileIds.includes(payload.managedProfileId)) {
        throw new WsException('Not assigned to this profile');
      }

      await this.conversationsService.assertParticipant(payload.conversationId, payload.managedProfileId);
      await this.conversationsService.markAsRead(payload.conversationId, payload.managedProfileId);

      client.emit('operator:conversation:read', {
        conversationId: payload.conversationId,
        managedProfileId: payload.managedProfileId,
      });
    } catch (err) {
      this.emitError(client, 'operator:mark-read', err);
    }
  }

  @SubscribeMessage('operator:ranking:set')
  async handleRankingSet(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: { profileId: string; rating: number; category: string },
  ) {
    try {
      const { operatorId } = client.data.operator;
      const ranking = await this.operatorService.setProfileRanking(
        payload.profileId, payload.rating, payload.category, operatorId,
      );
      client.emit('operator:ranking:updated', {
        profileId: payload.profileId,
        rating: ranking.rating,
        category: ranking.category,
        updatedBy: operatorId,
      });
    } catch (err) {
      this.emitError(client, 'operator:ranking:set', err);
    }
  }

  @SubscribeMessage('operator:ranking:get')
  async handleRankingGet(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: { profileId: string },
  ) {
    try {
      const ranking = await this.operatorService.getProfileRanking(payload.profileId);
      client.emit('operator:ranking:data', {
        profileId: payload.profileId,
        rating: ranking?.rating ?? null,
        category: ranking?.category ?? null,
      });
    } catch (err) {
      this.emitError(client, 'operator:ranking:get', err);
    }
  }

  @SubscribeMessage('operator:notes:save')
  async handleNotesSave(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: { profileId: string; content: string },
  ) {
    try {
      const { operatorId } = client.data.operator;
      const note = await this.operatorService.saveProfileNote(payload.profileId, operatorId, payload.content);
      client.emit('operator:notes:saved', {
        profileId: payload.profileId,
        note: { id: note.id, operatorId: note.operatorId, content: note.content, updatedAt: note.updatedAt.toISOString() },
      });
    } catch (err) {
      this.emitError(client, 'operator:notes:save', err);
    }
  }

  @SubscribeMessage('operator:notes:get')
  async handleNotesGet(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: { profileId: string },
  ) {
    try {
      const notes = await this.operatorService.getProfileNotes(payload.profileId);
      client.emit('operator:notes:data', {
        profileId: payload.profileId,
        notes: notes.map(n => ({
          id: n.id, operatorId: n.operatorId, content: n.content, updatedAt: n.updatedAt.toISOString(),
        })),
      });
    } catch (err) {
      this.emitError(client, 'operator:notes:get', err);
    }
  }

  @SubscribeMessage('operator:presence:check')
  async handlePresenceCheck(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: { profileIds: string[]; managedProfileId?: string },
  ) {
    try {
      const { appId } = client.data.operator;
      const presence = await this.profilesService.getBulkPresence(appId, payload.profileIds);

      // If managedProfileId provided, also check owner (account) presence
      let ownerOnline: boolean | null = null;
      if (payload.managedProfileId) {
        const managedProfile = await this.prisma.profile.findUnique({
          where: { id: payload.managedProfileId },
          select: { accountId: true },
        });
        if (managedProfile?.accountId) {
          ownerOnline = await this.profilesService.isAccountOnline(appId, managedProfile.accountId);
        }
      }

      client.emit('operator:presence:data', {
        presence,
        ownerOnline,
        managedProfileId: payload.managedProfileId ?? null,
      });
    } catch (err) {
      this.emitError(client, 'operator:presence:check', err);
    }
  }

  @OnEvent(CHAT_MESSAGE_CREATED)
  handleIncomingMessage(event: any) {
    if (event.source === 'operator') return; // Don't echo back

    for (const recipientId of (event as ChatMessageCreatedEvent).recipientProfileIds) {
      if (this.operatorService.isManagedProfile(recipientId)) {
        this.server
          .to('op:profile:' + recipientId)
          .emit('operator:message:received', event.message);
      }
    }
  }

  @OnEvent(CHAT_TYPING_UPDATE)
  handleIncomingTyping(event: any) {
    if (event.source === 'operator') return;

    for (const targetProfileId of (event as ChatTypingEvent).targetProfileIds) {
      if (this.operatorService.isManagedProfile(targetProfileId)) {
        this.server
          .to('op:profile:' + targetProfileId)
          .emit('operator:typing:update', {
            conversationId: event.conversationId,
            profileId: event.profileId,
            isTyping: event.isTyping,
          });
      }
    }
  }

  private emitError(client: Socket, event: string, err: any) {
    client.emit('error', {
      event,
      code:
        err instanceof WsException ? 'VALIDATION_ERROR' : 'INTERNAL_ERROR',
      message: err.message || 'Unknown error',
    });
  }
}
