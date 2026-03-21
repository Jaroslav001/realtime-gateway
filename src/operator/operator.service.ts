import { Inject, Injectable } from '@nestjs/common';
import Redis from 'ioredis';
import { REDIS_CLIENT } from '../redis/redis.module.js';

@Injectable()
export class OperatorService {
  private profileToOperators = new Map<string, Set<string>>();
  private operatorToProfiles = new Map<string, Set<string>>();

  constructor(@Inject(REDIS_CLIENT) private redis: Redis) {}

  registerOperator(operatorId: string, managedProfileIds: string[]): void {
    this.operatorToProfiles.set(operatorId, new Set(managedProfileIds));
    for (const profileId of managedProfileIds) {
      let operators = this.profileToOperators.get(profileId);
      if (!operators) {
        operators = new Set();
        this.profileToOperators.set(profileId, operators);
      }
      operators.add(operatorId);
    }
  }

  unregisterOperator(operatorId: string): void {
    const profiles = this.operatorToProfiles.get(operatorId);
    if (profiles) {
      for (const profileId of profiles) {
        const operators = this.profileToOperators.get(profileId);
        if (operators) {
          operators.delete(operatorId);
          if (operators.size === 0) {
            this.profileToOperators.delete(profileId);
          }
        }
      }
    }
    this.operatorToProfiles.delete(operatorId);
  }

  isManagedProfile(profileId: string): boolean {
    return (
      this.profileToOperators.has(profileId) &&
      this.profileToOperators.get(profileId)!.size > 0
    );
  }

  getOperatorsForProfile(profileId: string): string[] {
    return [...(this.profileToOperators.get(profileId) ?? [])];
  }

  getManagedProfileIds(operatorId: string): string[] {
    return [...(this.operatorToProfiles.get(operatorId) ?? [])];
  }
}
