import {
  Controller,
  Post,
  Delete,
  Body,
  UseGuards,
  Request,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { PushService } from './push.service.js';

@Controller('push-subscriptions')
@UseGuards(AuthGuard('jwt'))
export class PushController {
  constructor(private pushService: PushService) {}

  @Post()
  async subscribe(
    @Body()
    body: {
      endpoint: string;
      keys: { p256dh: string; auth: string };
      userAgent?: string;
    },
    @Request() req,
  ) {
    const { accountId } = req.user;
    await this.pushService.upsertSubscription(
      accountId,
      body.endpoint,
      body.keys.p256dh,
      body.keys.auth,
      body.userAgent,
    );
    return { ok: true };
  }

  @Delete()
  async unsubscribe(@Body() body: { endpoint: string }) {
    await this.pushService.removeSubscription(body.endpoint);
    return { ok: true };
  }
}
