import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { WsException } from '@nestjs/websockets';

@Injectable()
export class WsJwtGuard implements CanActivate {
  constructor(
    private jwtService: JwtService,
    private configService: ConfigService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const client = context.switchToWs().getClient();

    // Allow guest connections through — individual handlers check client.data.guest
    if (client.data?.guest) {
      return true;
    }

    const rawToken =
      client.handshake?.auth?.token ||
      client.handshake?.headers?.authorization;

    if (!rawToken) throw new WsException('No token provided');

    const token = rawToken.replace('Bearer ', '');

    try {
      const payload = this.jwtService.verify(token, {
        secret: this.configService.get<string>('jwt.secret'),
      });
      client.data.user = {
        userId: String(payload.sub),
        accountId: String(payload.account_id),
        appId: String(payload.app_id),
      };
      return true;
    } catch {
      throw new WsException('Invalid or expired token');
    }
  }
}
