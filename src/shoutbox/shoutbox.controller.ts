import {
  Controller,
  Get,
  Delete,
  Param,
  Query,
  UseGuards,
  Request,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ShoutboxService } from './shoutbox.service.js';
import { ChatGateway } from '../chat/chat.gateway.js';

@Controller('shoutbox')
export class ShoutboxController {
  constructor(
    private shoutboxService: ShoutboxService,
    private chatGateway: ChatGateway,
  ) {}

  @Get('messages')
  async getMessages(
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    const parsedLimit = limit ? Math.min(Math.max(parseInt(limit, 10), 1), 100) : 30;
    return this.shoutboxService.getMessages(parsedLimit, cursor || undefined);
  }

  @Delete('messages/:id')
  @UseGuards(AuthGuard('jwt'))
  async deleteMessage(@Param('id') id: string, @Request() req) {
    const { role } = req.user;
    if (role !== 'admin') {
      throw new ForbiddenException('Admin access required');
    }

    try {
      await this.shoutboxService.softDelete(id);
    } catch {
      throw new NotFoundException('Message not found');
    }

    this.chatGateway.server.to('shoutbox').emit('shoutbox:deleted', { id });

    return { deleted: true };
  }
}
