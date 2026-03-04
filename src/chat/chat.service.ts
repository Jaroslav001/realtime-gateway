import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { ConversationsService, MessageWithSender } from '../conversations/conversations.service.js';

@Injectable()
export class ChatService {
  constructor(
    private prisma: PrismaService,
    private conversationsService: ConversationsService,
  ) {}

  async saveMessage(
    conversationId: string,
    senderProfileId: string,
    content: string,
  ): Promise<MessageWithSender> {
    const message = await this.prisma.message.create({
      data: {
        conversationId,
        senderProfileId,
        content,
        type: 'TEXT',
      },
    });

    // Update conversation updatedAt
    await this.prisma.conversation.update({
      where: { id: conversationId },
      data: { updatedAt: new Date() },
    });

    return this.conversationsService.formatMessage(message);
  }

  async getMessages(
    conversationId: string,
    limit: number = 50,
    cursor?: string,
  ): Promise<{ messages: MessageWithSender[]; nextCursor: string | null }> {
    let cursorCondition = {};

    if (cursor) {
      const cursorMsg = await this.prisma.message.findUnique({ where: { id: cursor } });
      if (cursorMsg) {
        cursorCondition = { sentAt: { lt: cursorMsg.sentAt } };
      }
    }

    const messages = await this.prisma.message.findMany({
      where: {
        conversationId,
        deletedAt: null,
        ...cursorCondition,
      },
      orderBy: { sentAt: 'desc' },
      take: limit + 1,
    });

    const hasMore = messages.length > limit;
    const page = hasMore ? messages.slice(0, limit) : messages;
    const nextCursor = hasMore ? page[page.length - 1].id : null;

    const withSenders = await Promise.all(page.map(m => this.conversationsService.formatMessage(m)));

    return { messages: withSenders, nextCursor };
  }
}
