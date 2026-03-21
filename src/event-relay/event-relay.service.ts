import {
  Inject,
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { Server, Namespace } from 'socket.io';
import { REDIS_CLIENT } from '../redis/redis.module.js';
import Redis from 'ioredis';

const CHANNEL = 'events:broadcast';

/**
 * Generic Redis pub/sub → Socket.IO relay.
 *
 * Any backend service can publish an event envelope to the `events:broadcast`
 * Redis channel and the Gateway will forward it to the correct Socket.IO room.
 *
 * Envelope shape:
 * {
 *   "room": "account:123",
 *   "name": "file:status",
 *   "payload": { ... }
 * }
 */
@Injectable()
export class EventRelayService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EventRelayService.name);
  private subscriber: Redis;
  private servers = new Map<string, Server | Namespace>();

  constructor(@Inject(REDIS_CLIENT) private redis: Redis) {}

  onModuleInit() {
    // Duplicate the connection so the subscriber doesn't interfere with
    // regular Redis commands on the main client.
    this.subscriber = this.redis.duplicate();

    this.subscriber.subscribe(CHANNEL, (err) => {
      if (err) {
        this.logger.error(`Failed to subscribe to ${CHANNEL}`, err.message);
      } else {
        this.logger.log(`Subscribed to Redis channel: ${CHANNEL}`);
      }
    });

    this.subscriber.on('message', (_channel: string, message: string) => {
      try {
        const event = JSON.parse(message);
        const { room, name, payload } = event;

        if (!room || !name) {
          this.logger.warn('Received malformed event envelope (missing room or name)');
          return;
        }

        const target = this.getTargetServer(room);
        if (!target) {
          this.logger.warn(`No server registered for room: ${room}`);
          return;
        }

        target.to(room).emit(name, payload);
      } catch (err) {
        this.logger.error('Failed to parse/relay event', (err as Error).message);
      }
    });
  }

  onModuleDestroy() {
    if (this.subscriber) {
      this.subscriber.unsubscribe(CHANNEL).catch(() => {});
      this.subscriber.disconnect();
    }
  }

  /**
   * Called by gateways after bootstrap to register their Socket.IO server
   * or namespace instance. Routes events by room prefix.
   */
  setServer(server: Server | Namespace, namespace: string = 'default') {
    this.servers.set(namespace, server);
    this.logger.log(`Registered server for namespace: ${namespace}`);
  }

  private getTargetServer(room: string): Server | Namespace | undefined {
    if (room.startsWith('op:')) {
      return this.servers.get('operator');
    }
    return this.servers.get('default');
  }
}
