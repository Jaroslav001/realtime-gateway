import { IsString, IsOptional, IsInt, Min, Max, IsNotEmpty } from 'class-validator';
import { Type } from 'class-transformer';

export class GetMessagesDto {
  @IsString() @IsNotEmpty()
  profileId: string;

  @IsString() @IsNotEmpty()
  conversationId: string;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100)
  limit?: number = 50;

  @IsOptional() @IsString()
  cursor?: string;
}
