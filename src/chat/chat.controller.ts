import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  UseGuards,
  Request,
  ForbiddenException,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ProfilesService } from '../profiles/profiles.service.js';
import { ConversationsService } from '../conversations/conversations.service.js';
import { ChatService } from './chat.service.js';
import { ChatGateway } from './chat.gateway.js';
import { CreateConversationDto } from '../conversations/dto/create-conversation.dto.js';
import { RegisterProfilesDto } from '../profiles/dto/register-profiles.dto.js';
import { PrismaService } from '../prisma/prisma.service.js';

@Controller()
@UseGuards(AuthGuard('jwt'))
export class ChatController {
  constructor(
    private profilesService: ProfilesService,
    private conversationsService: ConversationsService,
    private chatService: ChatService,
    private chatGateway: ChatGateway,
    private prisma: PrismaService,
  ) {}

  private async assertProfileOwnership(profileId: string, req: any) {
    const { accountId, appId } = req.user;
    try {
      return await this.profilesService.assertOwnership(profileId, accountId, appId);
    } catch {
      throw new ForbiddenException('Profile not found or not owned by this account');
    }
  }

  @Post('profiles/register')
  async registerProfiles(@Body() dto: RegisterProfilesDto, @Request() req) {
    const { accountId, appId } = req.user;
    await Promise.all(
      dto.profiles.map((p) =>
        this.profilesService.upsertProfile({
          id: p.id,
          appId,
          accountId,
          displayName: p.displayName,
          avatarUrl: p.avatarUrl ?? null,
          age: p.age ?? null,
          city: p.city ?? null,
        }),
      ),
    );
    return { registered: dto.profiles.length };
  }

  @Get('conversations')
  async getConversations(@Query('profileId') profileId: string, @Request() req) {
    if (!profileId) throw new BadRequestException('profileId is required');
    await this.assertProfileOwnership(profileId, req);
    const convs = await this.conversationsService.getProfileConversations(req.user.appId, profileId);
    return convs.map(c => this.formatConversation(c));
  }

  @Get('conversations/:id')
  async getConversation(
    @Param('id') id: string,
    @Query('profileId') profileId: string,
    @Request() req,
  ) {
    if (!profileId) throw new BadRequestException('profileId is required');
    await this.assertProfileOwnership(profileId, req);

    const conv = await this.conversationsService.getSingleConversation(id, profileId, req.user.appId);
    if (!conv) throw new ForbiddenException('Conversation not found or access denied');
    return this.formatConversation(conv);
  }

  @Get('conversations/:id/messages')
  async getMessages(
    @Param('id') conversationId: string,
    @Query('profileId') profileId: string,
    @Query('limit') limit: string,
    @Query('cursor') cursor: string,
    @Request() req,
  ) {
    if (!profileId) throw new BadRequestException('profileId is required');
    await this.assertProfileOwnership(profileId, req);

    try {
      await this.conversationsService.assertParticipant(conversationId, profileId);
    } catch {
      throw new ForbiddenException('Not a participant of this conversation');
    }

    const parsedLimit = limit ? Math.min(Math.max(parseInt(limit, 10), 1), 100) : 50;
    const result = await this.chatService.getMessages(conversationId, parsedLimit, cursor);

    return {
      messages: result.messages.map(m => ({
        ...m,
        sentAt: m.sentAt.toISOString(),
      })),
      nextCursor: result.nextCursor,
    };
  }

  @Post('conversations')
  async createConversation(@Body() dto: CreateConversationDto, @Request() req) {
    const { appId } = req.user;
    await this.assertProfileOwnership(dto.profileId, req);

    if (dto.targetProfile) {
      await this.profilesService.upsertProfile({
        id: dto.targetProfileId,
        appId,
        accountId: null,
        displayName: dto.targetProfile.displayName,
        avatarUrl: dto.targetProfile.avatarUrl ?? null,
        age: dto.targetProfile.age ?? null,
        city: dto.targetProfile.city ?? null,
      });
    }

    const targetExists = await this.prisma.profile.findUnique({
      where: { id: dto.targetProfileId },
    });

    if (!targetExists) {
      throw new NotFoundException('Target profile not found. Pass targetProfile data to auto-create.');
    }

    let conversation;
    try {
      conversation = await this.conversationsService.findOrCreateDirectConversation(
        appId,
        dto.profileId,
        dto.targetProfileId,
      );
    } catch (err) {
      throw new BadRequestException(err.message || 'Cannot create conversation');
    }

    return {
      id: conversation.id,
      appId: conversation.appId,
      type: conversation.type,
      createdAt: conversation.createdAt,
      updatedAt: conversation.updatedAt,
    };
  }

  @Post('presence')
  async getPresence(@Body() body: { profileIds: string[] }, @Request() req) {
    const { profileIds } = body;
    if (!Array.isArray(profileIds) || profileIds.length === 0)
      throw new BadRequestException('profileIds is required');
    if (profileIds.length > 200)
      throw new BadRequestException('Maximum 200 profileIds per request');

    const { appId } = req.user;
    const profiles = await this.profilesService.getBulkPresence(appId, profileIds);
    return { profiles };
  }

  @Get('unread-count')
  async getUnreadCount(@Query('profileId') profileId: string, @Request() req) {
    if (!profileId) throw new BadRequestException('profileId is required');
    await this.assertProfileOwnership(profileId, req);

    const count = await this.conversationsService.getTotalUnreadCount(req.user.appId, profileId);
    return { count };
  }

  @Get('unread-count/all')
  async getAllUnreadCount(@Request() req) {
    const { accountId, appId } = req.user;
    const count = await this.conversationsService.getTotalUnreadCountByAccount(appId, accountId);
    return { count };
  }

  @Get('admin/connections')
  async getConnections() {
    return this.chatGateway.getConnectionsDebugInfo();
  }

  private formatConversation(c: any) {
    return {
      ...c,
      createdAt: c.createdAt?.toISOString?.() ?? c.createdAt,
      updatedAt: c.updatedAt?.toISOString?.() ?? c.updatedAt,
      lastMessage: c.lastMessage
        ? { ...c.lastMessage, sentAt: c.lastMessage.sentAt?.toISOString?.() ?? c.lastMessage.sentAt }
        : null,
    };
  }
}
