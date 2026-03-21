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
import { WsOperatorJwtGuard } from './ws-operator-jwt.guard.js';
import { OperatorService } from './operator.service.js';
import { EventRelayService } from '../event-relay/event-relay.service.js';
import { ChatService } from '../chat/chat.service.js';
import { ConversationsService } from '../conversations/conversations.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
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
