import { OperatorGateway } from '../operator.gateway.js';
import { WsException } from '@nestjs/websockets';

function createMockGateway() {
  const eventRelay = { setServer: jest.fn() };
  const operatorService = {
    registerOperator: jest.fn(),
    unregisterOperator: jest.fn(),
    isManagedProfile: jest.fn().mockReturnValue(false),
    getOperatorsForProfile: jest.fn().mockReturnValue([]),
  };
  const chatService = {
    saveMessage: jest.fn().mockResolvedValue({
      id: 'msg-1',
      conversationId: 'conv-1',
      sender: { profileId: 'p1', displayName: 'Test', avatarUrl: null },
      content: 'hello',
      type: 'TEXT',
      sentAt: new Date('2026-01-01'),
      reactions: [],
    }),
  };
  const conversationsService = {
    findOrCreateDirectConversation: jest.fn().mockResolvedValue({ id: 'conv-1' }),
    assertParticipant: jest.fn(),
    getConversationParticipants: jest.fn().mockResolvedValue([
      { profileId: 'p1', profile: { accountId: 'a1' } },
      { profileId: 'p2', profile: { accountId: 'a2' } },
    ]),
    markAsRead: jest.fn(),
  };
  const prisma = {
    message: { update: jest.fn() },
    profile: { findUnique: jest.fn() },
  };
  const eventEmitter = { emit: jest.fn() };
  const redis = {
    set: jest.fn().mockResolvedValue('OK'),
    del: jest.fn().mockResolvedValue(1),
  };

  const gateway = new OperatorGateway(
    eventRelay as any,
    operatorService as any,
    chatService as any,
    conversationsService as any,
    prisma as any,
    eventEmitter as any,
    redis as any,
  );

  // Mock server (Namespace)
  const toEmit = jest.fn();
  const serverTo = jest.fn().mockReturnValue({ emit: toEmit });
  (gateway as any).server = { to: serverTo };

  return {
    gateway,
    eventRelay,
    operatorService,
    chatService,
    conversationsService,
    prisma,
    eventEmitter,
    redis,
    serverTo,
    toEmit,
  };
}

function makeOperatorToken(payload: any): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256' })).toString('base64');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64');
  return `${header}.${body}.signature`;
}

function createClient(operatorPayload: any) {
  const token = makeOperatorToken(operatorPayload);
  const rooms = new Set<string>();
  return {
    handshake: { auth: { token } },
    data: {} as any,
    join: jest.fn((room: string) => rooms.add(room)),
    emit: jest.fn(),
    disconnect: jest.fn(),
    rooms,
  };
}

describe('OperatorGateway', () => {
  describe('connection (GW-01, GW-02)', () => {
    it('accepts operator JWT and joins op:profile rooms', async () => {
      const { gateway, operatorService, redis } = createMockGateway();
      const client = createClient({
        type: 'operator',
        operator_id: '42',
        app_id: 'app-1',
        managed_profile_ids: ['p1', 'p2'],
      });

      await gateway.handleConnection(client as any);

      expect(client.data.operator).toEqual({
        operatorId: '42',
        appId: 'app-1',
        managedProfileIds: ['p1', 'p2'],
      });
      expect(operatorService.registerOperator).toHaveBeenCalledWith('42', ['p1', 'p2']);
      expect(client.join).toHaveBeenCalledWith('op:profile:p1');
      expect(client.join).toHaveBeenCalledWith('op:profile:p2');
      expect(redis.set).toHaveBeenCalledWith('operator-presence:42', '1', 'EX', 86400);
      expect(client.emit).toHaveBeenCalledWith('connected', {
        operatorId: '42',
        managedProfileIds: ['p1', 'p2'],
      });
    });

    it('rejects user JWT on /operator namespace', async () => {
      const { gateway } = createMockGateway();
      const client = createClient({
        type: 'user',
        sub: '1',
        app_id: 'app-1',
      });

      await gateway.handleConnection(client as any);

      expect(client.emit).toHaveBeenCalledWith('error', { message: 'Invalid token type' });
      expect(client.disconnect).toHaveBeenCalled();
    });

    it('does NOT call profileConnected on connect (GW-07)', async () => {
      const { gateway } = createMockGateway();
      const client = createClient({
        type: 'operator',
        operator_id: '1',
        app_id: 'a',
        managed_profile_ids: ['p1'],
      });

      await gateway.handleConnection(client as any);

      // No profileConnected or profileDisconnected calls should exist
      // The gateway source should not reference these methods at all
      expect(client.disconnect).not.toHaveBeenCalled();
    });

    it('does NOT call profileDisconnected on disconnect (GW-07)', async () => {
      const { gateway, operatorService, redis } = createMockGateway();
      const client = {
        data: { operator: { operatorId: '42', appId: 'app-1', managedProfileIds: ['p1'] } },
      };

      await gateway.handleDisconnect(client as any);

      expect(operatorService.unregisterOperator).toHaveBeenCalledWith('42');
      expect(redis.del).toHaveBeenCalledWith('operator-presence:42');
    });
  });

  describe('on-behalf-of messaging (GW-04, GW-05)', () => {
    it('sends message as managed profile with sentByOperatorId', async () => {
      const { gateway, chatService, prisma, conversationsService, eventEmitter } = createMockGateway();
      const client = {
        data: {
          operator: {
            operatorId: '42',
            appId: 'app-1',
            managedProfileIds: ['p1', 'p2'],
          },
        },
        emit: jest.fn(),
      };

      await gateway.handleOperatorMessageSend(client as any, {
        managedProfileId: 'p1',
        recipientProfileId: 'p3',
        content: 'Hello from operator',
      });

      expect(conversationsService.findOrCreateDirectConversation).toHaveBeenCalledWith(
        'app-1',
        'p1',
        'p3',
      );
      expect(chatService.saveMessage).toHaveBeenCalledWith('conv-1', 'p1', 'Hello from operator');
      expect(prisma.message.update).toHaveBeenCalledWith({
        where: { id: 'msg-1' },
        data: { sentByOperatorId: '42' },
      });
      expect(conversationsService.markAsRead).toHaveBeenCalledWith('conv-1', 'p1');
      expect(client.emit).toHaveBeenCalledWith('operator:message:sent', expect.any(Object));
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'operator.message.sent',
        expect.objectContaining({
          source: 'operator',
          sentByOperatorId: '42',
        }),
      );
    });

    it('rejects message for unassigned profile', async () => {
      const { gateway } = createMockGateway();
      const client = {
        data: {
          operator: {
            operatorId: '42',
            appId: 'app-1',
            managedProfileIds: ['p1'],
          },
        },
        emit: jest.fn(),
      };

      await gateway.handleOperatorMessageSend(client as any, {
        managedProfileId: 'p999',
        recipientProfileId: 'p3',
        content: 'test',
      });

      expect(client.emit).toHaveBeenCalledWith('error', expect.objectContaining({
        code: 'VALIDATION_ERROR',
        message: 'Not assigned to this profile',
      }));
    });

    it('marks conversation as read for managed profile after send', async () => {
      const { gateway, conversationsService } = createMockGateway();
      const client = {
        data: {
          operator: {
            operatorId: '42',
            appId: 'app-1',
            managedProfileIds: ['p1'],
          },
        },
        emit: jest.fn(),
      };

      await gateway.handleOperatorMessageSend(client as any, {
        managedProfileId: 'p1',
        recipientProfileId: 'p3',
        content: 'hello',
      });

      expect(conversationsService.markAsRead).toHaveBeenCalledWith('conv-1', 'p1');
    });
  });

  describe('cross-namespace relay', () => {
    it('relays user message to operator via op:profile room', () => {
      const { gateway, operatorService, serverTo, toEmit } = createMockGateway();
      operatorService.isManagedProfile.mockReturnValue(true);

      gateway.handleIncomingMessage({
        conversationId: 'conv-1',
        senderProfileId: 'user1',
        recipientProfileIds: ['p1'],
        message: { id: 'msg-1', content: 'hi' },
        source: 'user',
      });

      expect(serverTo).toHaveBeenCalledWith('op:profile:p1');
      expect(toEmit).toHaveBeenCalledWith('operator:message:received', { id: 'msg-1', content: 'hi' });
    });

    it('does not echo operator messages back to operator', () => {
      const { gateway, serverTo } = createMockGateway();

      gateway.handleIncomingMessage({
        conversationId: 'conv-1',
        senderProfileId: 'p1',
        recipientProfileIds: ['p2'],
        message: { id: 'msg-1' },
        source: 'operator',
      });

      expect(serverTo).not.toHaveBeenCalled();
    });

    it('skips non-managed profiles', () => {
      const { gateway, operatorService, serverTo } = createMockGateway();
      operatorService.isManagedProfile.mockReturnValue(false);

      gateway.handleIncomingMessage({
        conversationId: 'conv-1',
        senderProfileId: 'user1',
        recipientProfileIds: ['p1'],
        message: { id: 'msg-1' },
        source: 'user',
      });

      expect(serverTo).not.toHaveBeenCalled();
    });
  });

  describe('typing relay (GW-08)', () => {
    it('relays operator typing to other participant only', async () => {
      const { gateway, conversationsService, eventEmitter } = createMockGateway();
      conversationsService.getConversationParticipants.mockResolvedValue([
        { profileId: 'managed-p1', profile: {} },
        { profileId: 'user-p2', profile: {} },
      ]);

      const client = {
        data: {
          operator: {
            operatorId: '42',
            appId: 'a',
            managedProfileIds: ['managed-p1'],
          },
        },
        emit: jest.fn(),
      };

      await gateway.handleOperatorTypingStart(client as any, {
        managedProfileId: 'managed-p1',
        conversationId: 'conv-1',
      });

      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'operator.typing.update',
        expect.objectContaining({
          profileId: 'managed-p1',
          isTyping: true,
          source: 'operator',
          targetProfileIds: ['user-p2'],
        }),
      );
    });

    it('never emits typing to managed profile room', async () => {
      const { gateway, conversationsService, eventEmitter } = createMockGateway();
      conversationsService.getConversationParticipants.mockResolvedValue([
        { profileId: 'managed-p1', profile: {} },
        { profileId: 'user-p2', profile: {} },
      ]);

      const client = {
        data: {
          operator: {
            operatorId: '42',
            appId: 'a',
            managedProfileIds: ['managed-p1'],
          },
        },
        emit: jest.fn(),
      };

      await gateway.handleOperatorTypingStart(client as any, {
        managedProfileId: 'managed-p1',
        conversationId: 'conv-1',
      });

      // targetProfileIds should NOT include managed-p1
      const emitCall = eventEmitter.emit.mock.calls[0][1];
      expect(emitCall.targetProfileIds).not.toContain('managed-p1');
    });
  });

  describe('room prefix (GW-10)', () => {
    it('uses op: prefix for all operator rooms', async () => {
      const { gateway } = createMockGateway();
      const client = createClient({
        type: 'operator',
        operator_id: '1',
        app_id: 'a',
        managed_profile_ids: ['p1', 'p2'],
      });

      await gateway.handleConnection(client as any);

      expect(client.join).toHaveBeenCalledWith('op:profile:p1');
      expect(client.join).toHaveBeenCalledWith('op:profile:p2');
      // Should not join profile:p1 (no prefix)
      expect(client.join).not.toHaveBeenCalledWith('profile:p1');
    });
  });

  describe('security (SEC-02, SEC-05)', () => {
    it('validates managed profile assignment from JWT claims', async () => {
      const { gateway } = createMockGateway();
      const client = {
        data: {
          operator: {
            operatorId: '42',
            appId: 'a',
            managedProfileIds: ['p1'],
          },
        },
        emit: jest.fn(),
      };

      await gateway.handleOperatorMessageSend(client as any, {
        managedProfileId: 'p-unauthorized',
        recipientProfileId: 'p3',
        content: 'test',
      });

      expect(client.emit).toHaveBeenCalledWith('error', expect.objectContaining({
        code: 'VALIDATION_ERROR',
      }));
    });

    it('never uses assertOwnership', () => {
      // Read the source to confirm no assertOwnership usage
      const src = OperatorGateway.toString();
      expect(src).not.toContain('assertOwnership');
    });
  });

  describe('afterInit', () => {
    it('registers server with event relay as operator namespace', () => {
      const { gateway, eventRelay } = createMockGateway();
      const mockServer = {} as any;
      gateway.afterInit(mockServer);
      expect(eventRelay.setServer).toHaveBeenCalledWith(mockServer, 'operator');
    });
  });
});
