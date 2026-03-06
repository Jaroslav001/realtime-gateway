import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import configuration from './config/configuration.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { RedisModule } from './redis/redis.module.js';
import { AuthModule } from './auth/auth.module.js';
import { ProfilesModule } from './profiles/profiles.module.js';
import { ConversationsModule } from './conversations/conversations.module.js';
import { ChatModule } from './chat/chat.module.js';
import { EventRelayModule } from './event-relay/event-relay.module.js';
import { HealthModule } from './health/health.module.js';
import { PushModule } from './push/push.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [configuration] }),
    PrismaModule,
    RedisModule,
    AuthModule,
    ProfilesModule,
    ConversationsModule,
    ChatModule,
    EventRelayModule,
    HealthModule,
    PushModule,
  ],
})
export class AppModule {}
