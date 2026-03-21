import { IsString, IsNotEmpty } from 'class-validator';

export class OperatorSendMessageDto {
  @IsString()
  @IsNotEmpty()
  managedProfileId: string;

  @IsString()
  @IsNotEmpty()
  recipientProfileId: string;

  @IsString()
  @IsNotEmpty()
  content: string;
}
