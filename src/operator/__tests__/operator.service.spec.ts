import { OperatorService } from '../operator.service.js';

describe('OperatorService', () => {
  let service: OperatorService;
  let mockRedis: any;

  beforeEach(() => {
    mockRedis = { set: jest.fn(), del: jest.fn() };
    service = new OperatorService(mockRedis);
  });

  describe('managed profile tracking', () => {
    it('registers operator with managed profile IDs', () => {
      service.registerOperator('op1', ['p1', 'p2', 'p3']);

      expect(service.getManagedProfileIds('op1')).toEqual(
        expect.arrayContaining(['p1', 'p2', 'p3']),
      );
      expect(service.isManagedProfile('p1')).toBe(true);
      expect(service.isManagedProfile('p2')).toBe(true);
      expect(service.isManagedProfile('p3')).toBe(true);
    });

    it('unregisters operator and cleans up', () => {
      service.registerOperator('op1', ['p1', 'p2']);
      service.unregisterOperator('op1');

      expect(service.isManagedProfile('p1')).toBe(false);
      expect(service.isManagedProfile('p2')).toBe(false);
      expect(service.getManagedProfileIds('op1')).toEqual([]);
    });

    it('isManagedProfile returns true for registered profiles', () => {
      service.registerOperator('op1', ['p1']);
      expect(service.isManagedProfile('p1')).toBe(true);
    });

    it('isManagedProfile returns false for unregistered profiles', () => {
      expect(service.isManagedProfile('unknown')).toBe(false);
    });

    it('isManagedProfile returns false after unregister', () => {
      service.registerOperator('op1', ['p1']);
      service.unregisterOperator('op1');
      expect(service.isManagedProfile('p1')).toBe(false);
    });

    it('getOperatorsForProfile returns correct operator IDs', () => {
      service.registerOperator('op1', ['p1', 'p2']);
      service.registerOperator('op2', ['p2', 'p3']);

      expect(service.getOperatorsForProfile('p1')).toEqual(['op1']);
      expect(service.getOperatorsForProfile('p2')).toEqual(
        expect.arrayContaining(['op1', 'op2']),
      );
      expect(service.getOperatorsForProfile('p3')).toEqual(['op2']);
    });

    it('handles multiple operators sharing same profile', () => {
      service.registerOperator('op1', ['shared']);
      service.registerOperator('op2', ['shared']);

      expect(service.isManagedProfile('shared')).toBe(true);
      expect(service.getOperatorsForProfile('shared')).toHaveLength(2);

      // Unregister one -- profile should still be managed
      service.unregisterOperator('op1');
      expect(service.isManagedProfile('shared')).toBe(true);
      expect(service.getOperatorsForProfile('shared')).toEqual(['op2']);

      // Unregister the other -- profile no longer managed
      service.unregisterOperator('op2');
      expect(service.isManagedProfile('shared')).toBe(false);
    });

    it('getOperatorsForProfile returns empty for unknown profile', () => {
      expect(service.getOperatorsForProfile('unknown')).toEqual([]);
    });

    it('unregister is idempotent', () => {
      service.registerOperator('op1', ['p1']);
      service.unregisterOperator('op1');
      service.unregisterOperator('op1'); // should not throw
      expect(service.isManagedProfile('p1')).toBe(false);
    });
  });
});
