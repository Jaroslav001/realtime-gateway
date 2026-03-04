export class UpsertProfileDto {
  id: string;
  appId: string;
  accountId: string | null;
  displayName: string;
  avatarUrl?: string | null;
  age?: number | null;
  city?: string | null;
}
