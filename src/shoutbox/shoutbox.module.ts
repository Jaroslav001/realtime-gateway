import { Module, forwardRef } from '@nestjs/common';
import { ShoutboxService } from './shoutbox.service.js';
import { ShoutboxController } from './shoutbox.controller.js';
import { ChatModule } from '../chat/chat.module.js';

@Module({
  imports: [forwardRef(() => ChatModule)],
  providers: [ShoutboxService],
  controllers: [ShoutboxController],
  exports: [ShoutboxService],
})
export class ShoutboxModule {}
