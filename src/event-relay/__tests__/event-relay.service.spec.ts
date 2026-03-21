import { EventRelayService } from '../event-relay.service';

describe('EventRelayService', () => {
  describe('multi-namespace routing (GW-06)', () => {
    it.todo('registers a server for a given namespace');
    it.todo('routes rooms with op: prefix to operator server');
    it.todo('routes rooms without op: prefix to default server');
    it.todo('warns when no server registered for room');
  });
});
