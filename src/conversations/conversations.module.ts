import { Module } from '@nestjs/common';
import { ConversationsService } from './conversations.service.js';
import { ProfilesModule } from '../profiles/profiles.module.js';

@Module({
  imports: [ProfilesModule],
  providers: [ConversationsService],
  exports: [ConversationsService],
})
export class ConversationsModule {}
