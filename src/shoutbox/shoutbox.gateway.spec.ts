import { ChatGateway } from '../chat/chat.gateway';
import { WsException } from '@nestjs/websockets';

// Mock dependencies
const mockRedisClient = {
  set: jest.fn(),
  del: jest.fn(),
  get: jest.fn(),
};

const mockProfilesService = {
  upsertProfile: jest.fn(),
  assertOwnership: jest.fn(),
  profileConnected: jest.fn(),
  isManuallyOffline: jest.fn().mockResolvedValue(false),
  isProfileOnline: jest.fn(),
  profileDisconnected: jest.fn(),
  getProfileLastSeen: jest.fn(),
  getProfilesByAccount: jest.fn(),
  getBulkPresence: jest.fn(),
  setManuallyOffline: jest.fn(),
  clearManuallyOffline: jest.fn(),
};

const mockConversationsService = {
  findOrCreateDirectConversation: jest.fn(),
  assertParticipant: jest.fn(),
  getConversationParticipants: jest.fn(),
  markAsRead: jest.fn(),
  getConversationUnreadCount: jest.fn(),
  groupReactions: jest.fn(),
  getTotalUnreadCountByAccount: jest.fn(),
};

const mockChatService = {
  saveMessage: jest.fn(),
  getMessages: jest.fn(),
};

const mockPrismaService = {
  participant: { findMany: jest.fn().mockResolvedValue([]) },
  messageReaction: { upsert: jest.fn(), deleteMany: jest.fn() },
};

const mockEventRelayService = {
  setServer: jest.fn(),
};

const mockPushService = {
  sendToAccount: jest.fn(),
  sendToAccountFiltered: jest.fn(),
};

const mockShoutboxService = {
  checkRateLimit: jest.fn(),
  createMessage: jest.fn(),
  getMessages: jest.fn(),
  softDelete: jest.fn(),
};

function createMockSocket(overrides: Record<string, any> = {}): any {
  return {
    id: 'socket-1',
    data: {},
    handshake: { auth: {}, headers: {} },
    join: jest.fn(),
    emit: jest.fn(),
    disconnect: jest.fn(),
    rooms: new Set(['socket-1']),
    ...overrides,
  };
}

const mockEmitFn = jest.fn();
const mockServer = {
  to: jest.fn().mockReturnValue({ emit: mockEmitFn }),
  fetchSockets: jest.fn().mockResolvedValue([]),
};

describe('ChatGateway - Shoutbox Behavior', () => {
  let gateway: ChatGateway;

  beforeEach(() => {
    jest.clearAllMocks();
    gateway = new ChatGateway(
      mockRedisClient as any,
      mockProfilesService as any,
      mockConversationsService as any,
      mockChatService as any,
      mockPrismaService as any,
      mockEventRelayService as any,
      mockPushService as any,
      mockShoutboxService as any,
      { emit: jest.fn() } as any,
      { isManagedProfile: jest.fn().mockReturnValue(false) } as any,
    );
    (gateway as any).server = mockServer;
  });

  describe('handleConnection - guest', () => {
    it('joins shoutbox room and marks as guest when no token provided', async () => {
      const client = createMockSocket({
        handshake: { auth: {}, headers: {} },
      });

      await gateway.handleConnection(client);

      expect(client.data.guest).toBe(true);
      expect(client.join).toHaveBeenCalledWith('shoutbox');
      expect(client.emit).toHaveBeenCalledWith('connected', { guest: true });
      expect(client.disconnect).not.toHaveBeenCalled();
    });
  });

  describe('handleConnection - authenticated', () => {
    it('auto-joins shoutbox room after successful auth', async () => {
      const payload = {
        sub: '1',
        account_id: 'acc1',
        app_id: 'app1',
      };
      const token = `header.${Buffer.from(JSON.stringify(payload)).toString('base64')}.signature`;
      const client = createMockSocket({
        handshake: {
          auth: {
            token,
            profile: { id: 'profile1', displayName: 'Alice' },
          },
          headers: {},
        },
      });

      await gateway.handleConnection(client);

      expect(client.join).toHaveBeenCalledWith('shoutbox');
      expect(client.join).toHaveBeenCalledWith('profile:profile1');
      expect(client.data.guest).toBeUndefined();
    });
  });

  describe('handleShoutboxSend', () => {
    it('blocks guests from sending', async () => {
      const client = createMockSocket();
      client.data.guest = true;

      await gateway.handleShoutboxSend(client, { content: 'hello' });

      expect(client.emit).toHaveBeenCalledWith('error', expect.objectContaining({
        event: 'shoutbox:send',
        message: 'Guests cannot send messages',
      }));
      expect(mockShoutboxService.createMessage).not.toHaveBeenCalled();
    });

    it('enforces rate limiting', async () => {
      const client = createMockSocket();
      client.data.profileId = 'profile1';
      client.data.appId = 'app1';
      mockShoutboxService.checkRateLimit.mockResolvedValue(false);

      await gateway.handleShoutboxSend(client, { content: 'hello' });

      expect(client.emit).toHaveBeenCalledWith('error', expect.objectContaining({
        event: 'shoutbox:send',
        message: 'Rate limited: wait 2 seconds between messages',
      }));
      expect(mockShoutboxService.createMessage).not.toHaveBeenCalled();
    });

    it('persists and broadcasts a valid message', async () => {
      const client = createMockSocket();
      client.data.profileId = 'profile1';
      client.data.appId = 'app1';
      mockShoutboxService.checkRateLimit.mockResolvedValue(true);
      const mockMsg = {
        id: 'msg1',
        appId: 'app1',
        senderProfileId: 'profile1',
        content: 'hello',
        sentAt: '2026-03-20T12:00:00.000Z',
        sender: { id: 'profile1', displayName: 'Alice', avatarUrl: null, age: 25 },
      };
      mockShoutboxService.createMessage.mockResolvedValue(mockMsg);

      await gateway.handleShoutboxSend(client, { content: 'hello' });

      expect(mockShoutboxService.createMessage).toHaveBeenCalledWith('app1', 'profile1', 'hello');
      expect(mockServer.to).toHaveBeenCalledWith('shoutbox');
      expect(mockEmitFn).toHaveBeenCalledWith('shoutbox:message', mockMsg);
    });

    it('rejects empty content', async () => {
      const client = createMockSocket();
      client.data.profileId = 'profile1';
      client.data.appId = 'app1';
      mockShoutboxService.checkRateLimit.mockResolvedValue(true);

      await gateway.handleShoutboxSend(client, { content: '' });

      expect(client.emit).toHaveBeenCalledWith('error', expect.objectContaining({
        event: 'shoutbox:send',
        message: 'Message must be 1-500 characters',
      }));
      expect(mockShoutboxService.createMessage).not.toHaveBeenCalled();
    });

    it('rejects content over 500 characters', async () => {
      const client = createMockSocket();
      client.data.profileId = 'profile1';
      client.data.appId = 'app1';
      mockShoutboxService.checkRateLimit.mockResolvedValue(true);

      await gateway.handleShoutboxSend(client, { content: 'x'.repeat(501) });

      expect(client.emit).toHaveBeenCalledWith('error', expect.objectContaining({
        event: 'shoutbox:send',
        message: 'Message must be 1-500 characters',
      }));
      expect(mockShoutboxService.createMessage).not.toHaveBeenCalled();
    });

    it('rejects whitespace-only content', async () => {
      const client = createMockSocket();
      client.data.profileId = 'profile1';
      client.data.appId = 'app1';
      mockShoutboxService.checkRateLimit.mockResolvedValue(true);

      await gateway.handleShoutboxSend(client, { content: '   ' });

      expect(client.emit).toHaveBeenCalledWith('error', expect.objectContaining({
        event: 'shoutbox:send',
        message: 'Message must be 1-500 characters',
      }));
      expect(mockShoutboxService.createMessage).not.toHaveBeenCalled();
    });
  });
});
