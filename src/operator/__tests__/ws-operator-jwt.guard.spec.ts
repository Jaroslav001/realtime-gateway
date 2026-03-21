import { WsOperatorJwtGuard } from '../ws-operator-jwt.guard.js';
import { WsException } from '@nestjs/websockets';

describe('WsOperatorJwtGuard', () => {
  let guard: WsOperatorJwtGuard;
  let jwtService: any;
  let configService: any;

  beforeEach(() => {
    jwtService = { verify: jest.fn() };
    configService = { get: jest.fn().mockReturnValue('test-secret') };
    guard = new WsOperatorJwtGuard(jwtService, configService);
  });

  function createContext(handshake: any) {
    const client = { handshake, data: {} as any };
    return {
      switchToWs: () => ({ getClient: () => client }),
      _client: client,
    };
  }

  describe('token validation (GW-02)', () => {
    it('accepts tokens with type:operator claim', async () => {
      jwtService.verify.mockReturnValue({
        type: 'operator',
        operator_id: '42',
        app_id: 'app-1',
        managed_profile_ids: ['p1', 'p2'],
      });

      const ctx = createContext({ auth: { token: 'valid-token' } });
      const result = await guard.canActivate(ctx as any);

      expect(result).toBe(true);
      expect(ctx._client.data.operator).toEqual({
        operatorId: '42',
        appId: 'app-1',
        managedProfileIds: ['p1', 'p2'],
      });
    });

    it('rejects tokens without type:operator claim', async () => {
      jwtService.verify.mockReturnValue({
        type: 'user',
        sub: '1',
        app_id: 'app-1',
      });

      const ctx = createContext({ auth: { token: 'user-token' } });
      await expect(guard.canActivate(ctx as any)).rejects.toThrow(WsException);
      await expect(guard.canActivate(ctx as any)).rejects.toThrow(
        'Invalid token type for operator namespace',
      );
    });

    it('extracts operatorId and managedProfileIds from claims', async () => {
      jwtService.verify.mockReturnValue({
        type: 'operator',
        operator_id: '99',
        app_id: 'app-2',
        managed_profile_ids: [10, 20, 30],
      });

      const ctx = createContext({ auth: { token: 'tok' } });
      await guard.canActivate(ctx as any);

      expect(ctx._client.data.operator.operatorId).toBe('99');
      expect(ctx._client.data.operator.appId).toBe('app-2');
      expect(ctx._client.data.operator.managedProfileIds).toEqual([
        '10',
        '20',
        '30',
      ]);
    });

    it('rejects expired tokens', async () => {
      jwtService.verify.mockImplementation(() => {
        throw new Error('jwt expired');
      });

      const ctx = createContext({ auth: { token: 'expired' } });
      await expect(guard.canActivate(ctx as any)).rejects.toThrow(WsException);
      await expect(guard.canActivate(ctx as any)).rejects.toThrow(
        'Invalid or expired token',
      );
    });

    it('rejects missing tokens', async () => {
      const ctx = createContext({ auth: {} });
      await expect(guard.canActivate(ctx as any)).rejects.toThrow(WsException);
      await expect(guard.canActivate(ctx as any)).rejects.toThrow(
        'No token provided',
      );
    });

    it('strips Bearer prefix from authorization header', async () => {
      jwtService.verify.mockReturnValue({
        type: 'operator',
        operator_id: '1',
        app_id: 'a',
        managed_profile_ids: [],
      });

      const ctx = createContext({
        auth: {},
        headers: { authorization: 'Bearer my-token' },
      });
      await guard.canActivate(ctx as any);

      expect(jwtService.verify).toHaveBeenCalledWith('my-token', {
        secret: 'test-secret',
      });
    });

    it('uses sub as operatorId fallback when operator_id is missing', async () => {
      jwtService.verify.mockReturnValue({
        type: 'operator',
        sub: '77',
        app_id: 'a',
      });

      const ctx = createContext({ auth: { token: 'tok' } });
      await guard.canActivate(ctx as any);

      expect(ctx._client.data.operator.operatorId).toBe('77');
      expect(ctx._client.data.operator.managedProfileIds).toEqual([]);
    });
  });
});
