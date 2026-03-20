import { Module } from '@nestjs/common';
import { ShoutboxService } from './shoutbox.service.js';

@Module({
  providers: [ShoutboxService],
  exports: [ShoutboxService],
})
export class ShoutboxModule {}
