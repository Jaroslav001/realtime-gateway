import { Module } from '@nestjs/common';
import { EventRelayService } from './event-relay.service.js';

@Module({
  providers: [EventRelayService],
  exports: [EventRelayService],
})
export class EventRelayModule {}
