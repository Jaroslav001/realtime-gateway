import { IsString, MaxLength, MinLength } from 'class-validator';

export class SendShoutboxMessageDto {
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  content: string;
}
