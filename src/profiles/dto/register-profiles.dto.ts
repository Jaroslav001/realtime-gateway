import { IsString, IsNotEmpty, IsOptional, IsArray, ValidateNested, IsNumber } from 'class-validator';
import { Type } from 'class-transformer';

export class RegisterProfileDto {
  @IsString() @IsNotEmpty()
  id: string;

  @IsString() @IsNotEmpty()
  displayName: string;

  @IsOptional() @IsString()
  avatarUrl?: string | null;

  @IsOptional() @IsNumber()
  age?: number | null;

  @IsOptional() @IsString()
  city?: string | null;
}

export class RegisterProfilesDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => RegisterProfileDto)
  profiles: RegisterProfileDto[];
}
