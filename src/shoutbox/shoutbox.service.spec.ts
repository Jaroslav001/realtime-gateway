import { ShoutboxService } from './shoutbox.service';

const mockPrisma = {
  shoutboxMessage: {
    create: jest.fn(),
    findMany: jest.fn(),
    findUnique: jest.fn(),
    update: jest.fn(),
  },
  profile: {
    findUnique: jest.fn(),
    findMany: jest.fn(),
  },
};

const mockRedis = {
  set: jest.fn(),
};

describe('ShoutboxService', () => {
  let service: ShoutboxService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new ShoutboxService(mockPrisma as any, mockRedis as any);
  });

  describe('createMessage', () => {
    it('persists a message and returns formatted output with sender', async () => {
      const now = new Date('2026-03-20T12:00:00Z');
      mockPrisma.shoutboxMessage.create.mockResolvedValue({
        id: 'msg1',
        appId: 'app1',
        senderProfileId: 'profile1',
        content: 'Hello world',
        sentAt: now,
        deletedAt: null,
      });
      mockPrisma.profile.findUnique.mockResolvedValue({
        id: 'profile1',
        displayName: 'Alice',
        avatarUrl: 'https://example.com/avatar.jpg',
        age: 25,
      });

      const result = await service.createMessage('app1', 'profile1', 'Hello world');

      expect(mockPrisma.shoutboxMessage.create).toHaveBeenCalledWith({
        data: { appId: 'app1', senderProfileId: 'profile1', content: 'Hello world' },
      });
      expect(result).toEqual({
        id: 'msg1',
        appId: 'app1',
        senderProfileId: 'profile1',
        content: 'Hello world',
        sentAt: now.toISOString(),
        sender: {
          id: 'profile1',
          displayName: 'Alice',
          avatarUrl: 'https://example.com/avatar.jpg',
          age: 25,
        },
      });
    });

    it('returns null sender when profile not found', async () => {
      mockPrisma.shoutboxMessage.create.mockResolvedValue({
        id: 'msg2',
        appId: 'app1',
        senderProfileId: 'deleted-profile',
        content: 'test',
        sentAt: new Date(),
        deletedAt: null,
      });
      mockPrisma.profile.findUnique.mockResolvedValue(null);

      const result = await service.createMessage('app1', 'deleted-profile', 'test');
      expect(result.sender).toBeNull();
    });
  });

  describe('getMessages', () => {
    it('returns messages ordered by sentAt desc with cursor pagination', async () => {
      const msgs = [
        { id: 'm3', appId: 'a1', senderProfileId: 'p1', content: 'c3', sentAt: new Date('2026-03-20T12:03:00Z'), deletedAt: null },
        { id: 'm2', appId: 'a1', senderProfileId: 'p1', content: 'c2', sentAt: new Date('2026-03-20T12:02:00Z'), deletedAt: null },
      ];
      mockPrisma.shoutboxMessage.findMany.mockResolvedValue(msgs);
      mockPrisma.profile.findMany.mockResolvedValue([
        { id: 'p1', displayName: 'Alice', avatarUrl: null, age: 25 },
      ]);

      const result = await service.getMessages(30);

      expect(mockPrisma.shoutboxMessage.findMany).toHaveBeenCalledWith({
        where: { deletedAt: null },
        orderBy: { sentAt: 'desc' },
        take: 31,
      });
      expect(result.messages).toHaveLength(2);
      expect(result.nextCursor).toBeNull();
    });

    it('returns nextCursor when there are more messages', async () => {
      const msgs = Array.from({ length: 3 }, (_, i) => ({
        id: `m${i}`,
        appId: 'a1',
        senderProfileId: 'p1',
        content: `msg ${i}`,
        sentAt: new Date(`2026-03-20T12:0${i}:00Z`),
        deletedAt: null,
      }));
      mockPrisma.shoutboxMessage.findMany.mockResolvedValue(msgs);
      mockPrisma.profile.findMany.mockResolvedValue([
        { id: 'p1', displayName: 'Alice', avatarUrl: null, age: 25 },
      ]);

      const result = await service.getMessages(2);

      expect(result.messages).toHaveLength(2);
      expect(result.nextCursor).toBe('m1');
    });

    it('uses cursor condition when cursor is provided', async () => {
      const cursorDate = new Date('2026-03-20T12:02:00Z');
      mockPrisma.shoutboxMessage.findUnique.mockResolvedValue({
        id: 'cursor-msg',
        sentAt: cursorDate,
      });
      mockPrisma.shoutboxMessage.findMany.mockResolvedValue([]);
      mockPrisma.profile.findMany.mockResolvedValue([]);

      await service.getMessages(30, 'cursor-msg');

      expect(mockPrisma.shoutboxMessage.findMany).toHaveBeenCalledWith({
        where: { deletedAt: null, sentAt: { lt: cursorDate } },
        orderBy: { sentAt: 'desc' },
        take: 31,
      });
    });

    it('excludes soft-deleted messages', async () => {
      mockPrisma.shoutboxMessage.findMany.mockResolvedValue([]);
      mockPrisma.profile.findMany.mockResolvedValue([]);

      await service.getMessages(30);

      expect(mockPrisma.shoutboxMessage.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ deletedAt: null }),
        }),
      );
    });
  });

  describe('checkRateLimit', () => {
    it('returns true when rate limit key is set (first call)', async () => {
      mockRedis.set.mockResolvedValue('OK');
      const result = await service.checkRateLimit('profile1');
      expect(result).toBe(true);
      expect(mockRedis.set).toHaveBeenCalledWith('ratelimit:shoutbox:profile1', '1', 'EX', 2, 'NX');
    });

    it('returns false when rate limit key already exists (second call)', async () => {
      mockRedis.set.mockResolvedValue(null);
      const result = await service.checkRateLimit('profile1');
      expect(result).toBe(false);
    });
  });

  describe('softDelete', () => {
    it('sets deletedAt on the message', async () => {
      const now = new Date();
      jest.useFakeTimers({ now });
      mockPrisma.shoutboxMessage.update.mockResolvedValue({ id: 'msg1', deletedAt: now });

      await service.softDelete('msg1');

      expect(mockPrisma.shoutboxMessage.update).toHaveBeenCalledWith({
        where: { id: 'msg1' },
        data: { deletedAt: now },
      });
      jest.useRealTimers();
    });
  });
});
