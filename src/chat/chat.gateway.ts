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
import { Inject, UseGuards } from '@nestjs/common';
import { Server, Socket } from 'socket.io';
import Redis from 'ioredis';
import { WsJwtGuard } from '../auth/ws-jwt.guard.js';
import { REDIS_CLIENT } from '../redis/redis.module.js';
import { ProfilesService } from '../profiles/profiles.service.js';
import { ConversationsService } from '../conversations/conversations.service.js';
import { ChatService } from './chat.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { EventRelayService } from '../event-relay/event-relay.service.js';
import { PushService } from '../push/push.service.js';

@WebSocketGateway({
  cors: {
    origin: (process.env.CORS_ORIGINS || '*').split(','),
    credentials: true,
  },
})
@UseGuards(WsJwtGuard)
export class ChatGateway implements OnGatewayConnection, OnGatewayDisconnect, OnGatewayInit {
  @WebSocketServer()
  server: Server;

  constructor(
    @Inject(REDIS_CLIENT) private redisClient: Redis,
    private profilesService: ProfilesService,
    private conversationsService: ConversationsService,
    private chatService: ChatService,
    private prisma: PrismaService,
    private eventRelay: EventRelayService,
    private pushService: PushService,
  ) {}

  afterInit(server: Server) {
    this.eventRelay.setServer(server);
  }

  private async broadcastPresenceChange(appId: string, profileId: string, isOnline: boolean) {
    const participants = await this.prisma.participant.findMany({
      where: { profileId },
      select: { conversation: { select: { participants: { select: { profileId: true } } } } },
    });

    const partnerIds = new Set<string>();
    for (const p of participants) {
      for (const cp of p.conversation.participants) {
        if (cp.profileId !== profileId) partnerIds.add(cp.profileId);
      }
    }

    const lastSeenAt = isOnline
      ? null
      : await this.profilesService.getProfileLastSeen(appId, profileId);

    for (const partnerId of partnerIds) {
      this.server.to(`profile:${partnerId}`).emit('presence:changed', {
        profileId,
        isOnline,
        lastSeenAt,
      });
    }

    // Also notify any clients watching this profile via presence-watch rooms
    this.server.to(`presence-watch:${profileId}`).emit('presence:changed', {
      profileId,
      isOnline,
      lastSeenAt,
    });
  }

  async handleConnection(client: Socket) {
    try {
      const rawToken =
        client.handshake?.auth?.token ||
        client.handshake?.headers?.authorization;

      if (!rawToken) {
        client.emit('error', { event: 'connect', code: 'UNAUTHORIZED', message: 'No token' });
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

      const user = {
        userId: String(payload.sub),
        accountId: String(payload.account_id),
        appId: String(payload.app_id),
      };
      client.data.user = user;

      const profileData = client.handshake.auth?.profile;
      if (!profileData?.id) {
        client.emit('error', { event: 'connect', code: 'VALIDATION_ERROR', message: 'Profile data required' });
        client.disconnect();
        return;
      }

      await this.profilesService.upsertProfile({
        id: String(profileData.id),
        appId: user.appId,
        accountId: user.accountId,
        displayName: profileData.displayName,
        avatarUrl: profileData.avatarUrl ?? null,
        age: profileData.age ?? null,
        city: profileData.city ?? null,
      });

      await this.profilesService.assertOwnership(
        String(profileData.id),
        user.accountId,
        user.appId,
      );

      const profileId = String(profileData.id);
      client.data.profileId = profileId;
      client.data.appId = user.appId;
      client.data.isPWA = !!client.handshake.auth?.isPWA;
      client.data.connectedAt = Date.now();

      await this.profilesService.profileConnected(user.appId, profileId, client.id);
      client.join(`profile:${profileId}`);
      client.join(`account:${user.accountId}`);

      // Broadcast presence if not manually offline
      const manuallyOffline = await this.profilesService.isManuallyOffline(user.appId, profileId);
      if (!manuallyOffline) {
        await this.broadcastPresenceChange(user.appId, profileId, true);
      }

      client.emit('connected', { profileId, appId: user.appId });

      // Notify admin watchers
      this.server.to('admin').emit('admin:connected', this.buildConnectionInfo(client));
    } catch (err) {
      client.emit('error', {
        event: 'connect',
        code: 'UNAUTHORIZED',
        message: err.message || 'Connection failed',
      });
      client.disconnect();
    }
  }

  async handleDisconnect(client: Socket) {
    // Notify admin watchers
    this.server.to('admin').emit('admin:disconnected', { socketId: client.id });

    // Clean up heartbeat key
    this.redisClient.del(`heartbeat:${client.id}`).catch(() => {});

    const { profileId, appId, extraProfileIds } = client.data ?? {};
    if (profileId && appId) {
      const remaining = await this.profilesService.profileDisconnected(appId, profileId, client.id);
      if (remaining === 0) {
        await this.broadcastPresenceChange(appId, profileId, false);
      }
      for (const id of extraProfileIds ?? []) {
        const extraRemaining = await this.profilesService.profileDisconnected(appId, id, client.id);
        if (extraRemaining === 0) {
          await this.broadcastPresenceChange(appId, id, false);
        }
      }
    }
  }

  @SubscribeMessage('profiles:join')
  async handleProfilesJoin(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: { profileIds: string[] },
  ) {
    try {
      const { accountId, appId } = client.data.user;
      const ownedProfiles = await this.profilesService.getProfilesByAccount(accountId, appId);
      const ownedIds = new Set(ownedProfiles.map((p) => p.id));

      const extra: string[] = [];
      for (const id of payload.profileIds) {
        if (ownedIds.has(id) && id !== client.data.profileId) {
          await this.profilesService.profileConnected(appId, id, client.id);
          client.join(`profile:${id}`);
          extra.push(id);

          const manuallyOffline = await this.profilesService.isManuallyOffline(appId, id);
          if (!manuallyOffline) {
            await this.broadcastPresenceChange(appId, id, true);
          }
        }
      }
      client.data.extraProfileIds = extra;

      // Collect manually offline profile IDs
      const allIds = [client.data.profileId, ...extra];
      const manualOffline: string[] = [];
      for (const id of allIds) {
        if (await this.profilesService.isManuallyOffline(appId, id)) {
          manualOffline.push(id);
        }
      }

      client.emit('profiles:joined', { profileIds: allIds, manualOffline });
    } catch (err) {
      this.emitError(client, 'profiles:join', err);
    }
  }

  @SubscribeMessage('presence:subscribe')
  async handlePresenceSubscribe(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: { profileIds: string[] },
  ) {
    try {
      const { appId } = client.data;
      const ids = (payload.profileIds ?? []).slice(0, 500).map(String);

      // Leave all previous presence-watch rooms (full-replace semantics)
      for (const room of client.rooms) {
        if (room.startsWith('presence-watch:')) {
          client.leave(room);
        }
      }

      // Join new presence-watch rooms
      for (const id of ids) {
        client.join(`presence-watch:${id}`);
      }

      // Send current presence snapshot
      const presence = await this.profilesService.getBulkPresence(appId, ids);
      client.emit('presence:snapshot', presence);
    } catch (err) {
      this.emitError(client, 'presence:subscribe', err);
    }
  }

  @SubscribeMessage('presence:unsubscribe')
  async handlePresenceUnsubscribe(
    @ConnectedSocket() client: Socket,
  ) {
    for (const room of client.rooms) {
      if (room.startsWith('presence-watch:')) {
        client.leave(room);
      }
    }
  }

  @SubscribeMessage('profile:set-offline')
  async handleProfileSetOffline(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: { profileId: string },
  ) {
    try {
      const { accountId, appId } = client.data.user;
      await this.profilesService.assertOwnership(payload.profileId, accountId, appId);
      await this.profilesService.setManuallyOffline(appId, payload.profileId);
      await this.broadcastPresenceChange(appId, payload.profileId, false);
      client.emit('profile:offline-set', { profileId: payload.profileId });
    } catch (err) {
      this.emitError(client, 'profile:set-offline', err);
    }
  }

  @SubscribeMessage('profile:set-online')
  async handleProfileSetOnline(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: { profileId: string },
  ) {
    try {
      const { accountId, appId } = client.data.user;
      await this.profilesService.assertOwnership(payload.profileId, accountId, appId);
      await this.profilesService.clearManuallyOffline(appId, payload.profileId);
      const hasActiveSockets = await this.profilesService.isProfileOnline(appId, payload.profileId);
      if (hasActiveSockets) {
        await this.broadcastPresenceChange(appId, payload.profileId, true);
      }
      client.emit('profile:online-set', { profileId: payload.profileId });
    } catch (err) {
      this.emitError(client, 'profile:set-online', err);
    }
  }

  @SubscribeMessage('heartbeat')
  handleHeartbeat(@ConnectedSocket() client: Socket) {
    if (!client.data?.user) return;
    this.redisClient.set(`heartbeat:${client.id}`, '1', 'EX', 25);
    this.server.to('admin').emit('admin:heartbeat', { socketId: client.id, hasHeartbeat: true });
  }

  @SubscribeMessage('push:endpoint')
  handlePushEndpoint(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: { endpoint: string },
  ) {
    if (payload?.endpoint) {
      client.data.pushEndpoint = payload.endpoint;
    }
  }

  @SubscribeMessage('admin:subscribe')
  async handleAdminSubscribe(@ConnectedSocket() client: Socket) {
    client.join('admin');
    const snapshot = await this.getConnectionsDebugInfo();
    client.emit('admin:snapshot', snapshot);
  }

  private buildConnectionInfo(client: Socket) {
    return {
      socketId: client.id,
      accountId: client.data?.user?.accountId ?? null,
      profileId: client.data?.profileId ?? null,
      extraProfileIds: client.data?.extraProfileIds ?? [],
      isPWA: client.data?.isPWA ?? false,
      pushEndpoint: client.data?.pushEndpoint ?? null,
      hasHeartbeat: false,
      connectedAt: client.data?.connectedAt ?? null,
      userAgent: client.handshake?.headers?.['user-agent'] ?? null,
      rooms: [...client.rooms],
      ip: client.handshake?.address ?? null,
    };
  }

  async getConnectionsDebugInfo() {
    const sockets = await this.server.fetchSockets();
    const connections: ReturnType<ChatGateway['buildConnectionInfo']>[] = [];

    for (const s of sockets) {
      const hb = await this.redisClient.get(`heartbeat:${s.id}`);
      connections.push({
        socketId: s.id,
        accountId: s.data?.user?.accountId ?? null,
        profileId: s.data?.profileId ?? null,
        extraProfileIds: s.data?.extraProfileIds ?? [],
        isPWA: s.data?.isPWA ?? false,
        pushEndpoint: s.data?.pushEndpoint ?? null,
        hasHeartbeat: !!hb,
        connectedAt: s.data?.connectedAt ?? null,
        userAgent: s.handshake?.headers?.['user-agent'] ?? null,
        rooms: [...s.rooms],
        ip: s.handshake?.address ?? null,
      });
    }

    const uniqueAccounts = new Set(connections.map((c) => c.accountId).filter(Boolean));
    const uniqueProfiles = new Set(connections.map((c) => c.profileId).filter(Boolean));

    return {
      summary: {
        totalSockets: connections.length,
        uniqueAccounts: uniqueAccounts.size,
        uniqueProfiles: uniqueProfiles.size,
        withHeartbeat: connections.filter((c) => c.hasHeartbeat).length,
      },
      connections,
    };
  }

  @SubscribeMessage('conversation:create')
  async handleConversationCreate(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: { profileId: string; targetProfileId: string },
  ) {
    try {
      const { accountId, appId } = client.data.user;
      await this.profilesService.assertOwnership(payload.profileId, accountId, appId);

      const conversation = await this.conversationsService.findOrCreateDirectConversation(
        appId,
        payload.profileId,
        payload.targetProfileId,
      );

      client.emit('conversation:created', conversation);
    } catch (err) {
      this.emitError(client, 'conversation:create', err);
    }
  }

  @SubscribeMessage('message:send')
  async handleMessageSend(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: { profileId: string; conversationId: string; content: string },
  ) {
    try {
      const { accountId, appId } = client.data.user;
      await this.profilesService.assertOwnership(payload.profileId, accountId, appId);
      await this.conversationsService.assertParticipant(payload.conversationId, payload.profileId);

      const trimmed = payload.content?.trim();
      if (!trimmed) {
        throw new WsException('Message content cannot be empty');
      }

      const message = await this.chatService.saveMessage(
        payload.conversationId,
        payload.profileId,
        trimmed,
      );

      const msgPayload = { ...message, sentAt: message.sentAt.toISOString() };

      const participants = await this.conversationsService.getConversationParticipants(
        payload.conversationId,
      );

      for (const p of participants) {
        if (p.profileId !== payload.profileId) {
          this.server.to(`profile:${p.profileId}`).emit('message:received', msgPayload);

          // Notification to account room (skip sender's own account)
          if (p.profile.accountId && p.profile.accountId !== accountId) {
            this.server.to(`account:${p.profile.accountId}`).emit('notification:new-message', {
              conversationId: payload.conversationId,
              profileId: payload.profileId,
              targetProfileId: p.profileId,
              senderName: message.sender.displayName,
              senderAvatar: message.sender.avatarUrl,
              messagePreview: trimmed.slice(0, 80),
              createdAt: msgPayload.sentAt,
            });

            // Per-device push suppression: skip push for devices with active heartbeat
            const targetAccountId = p.profile.accountId!;
            (async () => {
              const accountSockets = await this.server.in(`account:${targetAccountId}`).fetchSockets();
              const suppressedEndpoints = new Set<string>();
              for (const s of accountSockets) {
                if (s.data.pushEndpoint) {
                  const hb = await this.redisClient.get(`heartbeat:${s.id}`);
                  if (hb) suppressedEndpoints.add(s.data.pushEndpoint);
                }
              }

              const unreadCount = await this.conversationsService.getTotalUnreadCountByAccount(appId, targetAccountId).catch(() => 0);
              const pushPayload = {
                title: message.sender.displayName,
                body: trimmed.slice(0, 80),
                icon: message.sender.avatarUrl || '/icon-192x192.png',
                conversationId: payload.conversationId,
                targetProfileId: p.profileId,
                unreadCount,
              };

              if (suppressedEndpoints.size > 0) {
                await this.pushService.sendToAccountFiltered(targetAccountId, pushPayload, suppressedEndpoints);
              } else {
                await this.pushService.sendToAccount(targetAccountId, pushPayload);
              }
            })().catch(() => {});
          }
        }
      }

      client.emit('message:sent', msgPayload);
    } catch (err) {
      this.emitError(client, 'message:send', err);
    }
  }

  @SubscribeMessage('message:history')
  async handleMessageHistory(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: { profileId: string; conversationId: string; limit?: number; cursor?: string },
  ) {
    try {
      const { accountId, appId } = client.data.user;
      await this.profilesService.assertOwnership(payload.profileId, accountId, appId);
      await this.conversationsService.assertParticipant(payload.conversationId, payload.profileId);

      const result = await this.chatService.getMessages(
        payload.conversationId,
        payload.limit ?? 50,
        payload.cursor,
      );

      client.emit('message:history', {
        messages: result.messages.map(m => ({ ...m, sentAt: m.sentAt.toISOString() })),
        nextCursor: result.nextCursor,
      });
    } catch (err) {
      this.emitError(client, 'message:history', err);
    }
  }

  @SubscribeMessage('typing:start')
  async handleTypingStart(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: { profileId: string; conversationId: string },
  ) {
    await this.broadcastTyping(client, payload, true);
  }

  @SubscribeMessage('typing:stop')
  async handleTypingStop(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: { profileId: string; conversationId: string },
  ) {
    await this.broadcastTyping(client, payload, false);
  }

  private async broadcastTyping(
    client: Socket,
    payload: { profileId: string; conversationId: string },
    isTyping: boolean,
  ) {
    try {
      const { accountId, appId } = client.data.user;
      await this.profilesService.assertOwnership(payload.profileId, accountId, appId);
      await this.conversationsService.assertParticipant(payload.conversationId, payload.profileId);

      const participants = await this.conversationsService.getConversationParticipants(
        payload.conversationId,
      );

      for (const p of participants) {
        if (p.profileId !== payload.profileId) {
          this.server.to(`profile:${p.profileId}`).emit('typing:update', {
            conversationId: payload.conversationId,
            profileId: payload.profileId,
            isTyping,
          });
        }
      }
    } catch (err) {
      this.emitError(client, isTyping ? 'typing:start' : 'typing:stop', err);
    }
  }

  @SubscribeMessage('conversation:read')
  async handleConversationRead(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: { profileId: string; conversationId: string },
  ) {
    try {
      const { accountId, appId } = client.data.user;
      await this.profilesService.assertOwnership(payload.profileId, accountId, appId);

      await this.conversationsService.markAsRead(payload.conversationId, payload.profileId);

      const unreadCount = await this.conversationsService.getConversationUnreadCount(
        payload.conversationId,
        payload.profileId,
      );

      client.emit('unread:updated', { conversationId: payload.conversationId, unreadCount });

      const participants = await this.conversationsService.getConversationParticipants(
        payload.conversationId,
      );
      const now = new Date().toISOString();
      for (const p of participants) {
        if (p.profileId !== payload.profileId) {
          this.server.to(`profile:${p.profileId}`).emit('messages:read', {
            conversationId: payload.conversationId,
            profileId: payload.profileId,
            lastReadAt: now,
          });
        }
      }
    } catch (err) {
      this.emitError(client, 'conversation:read', err);
    }
  }

  @SubscribeMessage('reaction:add')
  async handleReactionAdd(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: { profileId: string; conversationId: string; messageId: string; emoji: string },
  ) {
    try {
      const { accountId, appId } = client.data.user;
      await this.profilesService.assertOwnership(payload.profileId, accountId, appId);
      await this.conversationsService.assertParticipant(payload.conversationId, payload.profileId);

      await this.prisma.messageReaction.upsert({
        where: {
          messageId_profileId_emoji: {
            messageId: payload.messageId,
            profileId: payload.profileId,
            emoji: payload.emoji,
          },
        },
        create: {
          messageId: payload.messageId,
          profileId: payload.profileId,
          appId: client.data.user.appId,
          emoji: payload.emoji,
        },
        update: {},
      });

      await this.broadcastReactionUpdate(payload.conversationId, payload.messageId);
    } catch (err) {
      this.emitError(client, 'reaction:add', err);
    }
  }

  @SubscribeMessage('reaction:remove')
  async handleReactionRemove(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: { profileId: string; conversationId: string; messageId: string; emoji: string },
  ) {
    try {
      const { accountId, appId } = client.data.user;
      await this.profilesService.assertOwnership(payload.profileId, accountId, appId);
      await this.conversationsService.assertParticipant(payload.conversationId, payload.profileId);

      await this.prisma.messageReaction.deleteMany({
        where: {
          messageId: payload.messageId,
          profileId: payload.profileId,
          emoji: payload.emoji,
        },
      });

      await this.broadcastReactionUpdate(payload.conversationId, payload.messageId);
    } catch (err) {
      this.emitError(client, 'reaction:remove', err);
    }
  }

  private async broadcastReactionUpdate(conversationId: string, messageId: string) {
    const reactions = await this.conversationsService.groupReactions(messageId);
    const participants = await this.conversationsService.getConversationParticipants(conversationId);

    for (const p of participants) {
      this.server.to(`profile:${p.profileId}`).emit('reaction:updated', {
        conversationId,
        messageId,
        reactions,
      });
    }
  }

  private emitError(client: Socket, event: string, err: any) {
    const code =
      err instanceof WsException
        ? err.message.includes('not found') || err.message.includes('not owned')
          ? 'UNAUTHORIZED'
          : 'VALIDATION_ERROR'
        : 'INTERNAL_ERROR';

    client.emit('error', {
      event,
      code,
      message: err.message || 'An error occurred',
    });
  }
}
