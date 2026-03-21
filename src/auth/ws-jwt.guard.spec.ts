import { WsJwtGuard } from './ws-jwt.guard';

describe('WsJwtGuard', () => {
  describe('operator token rejection (GW-03)', () => {
    it.todo('rejects tokens with type:operator claim');
    it.todo('allows tokens without type:operator claim');
  });
});
