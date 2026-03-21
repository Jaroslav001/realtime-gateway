describe('OperatorGateway', () => {
  describe('connection (GW-01, GW-02)', () => {
    it.todo('accepts operator JWT and joins op:profile rooms');
    it.todo('rejects user JWT on /operator namespace');
    it.todo('does NOT call profileConnected on connect (GW-07)');
    it.todo('does NOT call profileDisconnected on disconnect (GW-07)');
  });

  describe('on-behalf-of messaging (GW-04, GW-05)', () => {
    it.todo('sends message as managed profile with sentByOperatorId');
    it.todo('rejects message for unassigned profile');
    it.todo('marks conversation as read for managed profile after send');
  });

  describe('cross-namespace relay', () => {
    it.todo('relays user message to operator via op:profile room');
    it.todo('does not echo operator messages back to operator');
  });

  describe('typing relay (GW-08)', () => {
    it.todo('relays operator typing to other participant only');
    it.todo('never emits typing to managed profile room');
  });

  describe('room prefix (GW-10)', () => {
    it.todo('uses op: prefix for all operator rooms');
  });

  describe('security (SEC-02, SEC-04, SEC-05)', () => {
    it.todo('validates managed profile assignment from JWT claims');
    it.todo('never uses assertOwnership');
  });
});
