import { Module } from '@nestjs/common';
import { ChatGateway } from './chat.gateway.js';
import { ChatService } from './chat.service.js';
import { ChatController } from './chat.controller.js';
import { ProfilesModule } from '../profiles/profiles.module.js';
import { ConversationsModule } from '../conversations/conversations.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { EventRelayModule } from '../event-relay/event-relay.module.js';
import { PushModule } from '../push/push.module.js';

@Module({
  imports: [AuthModule, ProfilesModule, ConversationsModule, EventRelayModule, PushModule],
  providers: [ChatGateway, ChatService],
  controllers: [ChatController],
  exports: [ChatGateway],
})
export class ChatModule {}
