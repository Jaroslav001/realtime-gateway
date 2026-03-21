import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { WsException } from '@nestjs/websockets';

@Injectable()
export class WsOperatorJwtGuard implements CanActivate {
  constructor(
    private jwtService: JwtService,
    private configService: ConfigService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const client = context.switchToWs().getClient();

    const rawToken =
      client.handshake?.auth?.token ||
      client.handshake?.headers?.authorization;

    if (!rawToken) {
      throw new WsException('No token provided');
    }

    const token = rawToken.replace('Bearer ', '');

    try {
      const payload = this.jwtService.verify(token, {
        secret: this.configService.get<string>('jwt.secret'),
      });

      if (payload.type !== 'operator') {
        throw new WsException('Invalid token type for operator namespace');
      }

      client.data.operator = {
        operatorId: String(payload.operator_id ?? payload.sub),
        appId: String(payload.app_id),
        managedProfileIds: (payload.managed_profile_ids ?? []).map(String),
      };

      return true;
    } catch (err) {
      if (err instanceof WsException) throw err;
      throw new WsException('Invalid or expired token');
    }
  }
}
