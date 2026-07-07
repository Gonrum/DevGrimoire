import { IsOptional, IsString } from 'class-validator';

export class DownloadTicketDto {
  @IsOptional() @IsString() environmentId?: string;
}
