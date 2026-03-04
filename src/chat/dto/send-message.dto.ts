import { IsString, IsNotEmpty, MaxLength } from 'class-validator';

export class SendMessageDto {
  @IsString() @IsNotEmpty()
  profileId: string;

  @IsString() @IsNotEmpty()
  conversationId: string;

  @IsString() @IsNotEmpty() @MaxLength(5000)
  content: string;
}
