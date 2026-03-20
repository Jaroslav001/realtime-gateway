import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { ShoutboxController } from './shoutbox.controller.js';
import { ShoutboxService } from './shoutbox.service.js';
import { ChatGateway } from '../chat/chat.gateway.js';

describe('ShoutboxController', () => {
  let controller: ShoutboxController;
  let shoutboxService: { getMessages: jest.Mock; softDelete: jest.Mock };
  let chatGateway: { server: { to: jest.Mock } };
  let emitMock: jest.Mock;

  beforeEach(async () => {
    emitMock = jest.fn();
    shoutboxService = {
      getMessages: jest.fn(),
      softDelete: jest.fn(),
    };
    chatGateway = {
      server: {
        to: jest.fn().mockReturnValue({ emit: emitMock }),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [ShoutboxController],
      providers: [
        { provide: ShoutboxService, useValue: shoutboxService },
        { provide: ChatGateway, useValue: chatGateway },
      ],
    }).compile();

    controller = module.get<ShoutboxController>(ShoutboxController);
  });

  describe('GET /shoutbox/messages', () => {
    it('calls getMessages with default limit 30 when no params', async () => {
      const mockResult = { messages: [], nextCursor: null };
      shoutboxService.getMessages.mockResolvedValue(mockResult);

      const result = await controller.getMessages();

      expect(shoutboxService.getMessages).toHaveBeenCalledWith(30, undefined);
      expect(result).toEqual(mockResult);
    });

    it('calls getMessages with provided limit and cursor', async () => {
      const mockResult = { messages: [{ id: '1' }], nextCursor: 'abc' };
      shoutboxService.getMessages.mockResolvedValue(mockResult);

      const result = await controller.getMessages('10', 'abc');

      expect(shoutboxService.getMessages).toHaveBeenCalledWith(10, 'abc');
      expect(result).toEqual(mockResult);
    });

    it('clamps limit to 100 when exceeding max', async () => {
      shoutboxService.getMessages.mockResolvedValue({ messages: [], nextCursor: null });

      await controller.getMessages('999');

      expect(shoutboxService.getMessages).toHaveBeenCalledWith(100, undefined);
    });

    it('clamps limit to 1 when below min', async () => {
      shoutboxService.getMessages.mockResolvedValue({ messages: [], nextCursor: null });

      await controller.getMessages('0');

      expect(shoutboxService.getMessages).toHaveBeenCalledWith(1, undefined);
    });
  });

  describe('DELETE /shoutbox/messages/:id', () => {
    it('soft-deletes message, broadcasts deletion, and returns { deleted: true } for admin', async () => {
      shoutboxService.softDelete.mockResolvedValue({});
      const req = { user: { role: 'admin' } };

      const result = await controller.deleteMessage('msg-123', req);

      expect(shoutboxService.softDelete).toHaveBeenCalledWith('msg-123');
      expect(chatGateway.server.to).toHaveBeenCalledWith('shoutbox');
      expect(emitMock).toHaveBeenCalledWith('shoutbox:deleted', { id: 'msg-123' });
      expect(result).toEqual({ deleted: true });
    });

    it('throws ForbiddenException for non-admin user', async () => {
      const req = { user: { role: 'client' } };

      await expect(controller.deleteMessage('msg-123', req)).rejects.toThrow(ForbiddenException);
      expect(shoutboxService.softDelete).not.toHaveBeenCalled();
    });

    it('throws NotFoundException when message does not exist', async () => {
      shoutboxService.softDelete.mockRejectedValue(new Error('Record not found'));
      const req = { user: { role: 'admin' } };

      await expect(controller.deleteMessage('nonexistent', req)).rejects.toThrow(NotFoundException);
    });
  });
});
