import { IsString, IsNotEmpty, IsOptional, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

export class TargetProfileDto {
  @IsString() @IsNotEmpty()
  displayName: string;

  @IsOptional() @IsString()
  avatarUrl?: string | null;

  @IsOptional()
  age?: number | null;

  @IsOptional() @IsString()
  city?: string | null;
}

export class CreateConversationDto {
  @IsString() @IsNotEmpty()
  profileId: string;

  @IsString() @IsNotEmpty()
  targetProfileId: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => TargetProfileDto)
  targetProfile?: TargetProfileDto;
}
