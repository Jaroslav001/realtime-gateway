import { Module, forwardRef } from '@nestjs/common';
import { OperatorGateway } from './operator.gateway.js';
import { OperatorService } from './operator.service.js';
import { WsOperatorJwtGuard } from './ws-operator-jwt.guard.js';
import { AuthModule } from '../auth/auth.module.js';
import { ConversationsModule } from '../conversations/conversations.module.js';
import { ChatModule } from '../chat/chat.module.js';
import { EventRelayModule } from '../event-relay/event-relay.module.js';
import { ProfilesModule } from '../profiles/profiles.module.js';

@Module({
  imports: [
    AuthModule,
    ConversationsModule,
    forwardRef(() => ChatModule),
    EventRelayModule,
    ProfilesModule,
  ],
  providers: [OperatorGateway, OperatorService, WsOperatorJwtGuard],
  exports: [OperatorService],
})
export class OperatorModule {}
