import { IsOptional, IsNumber, IsMongoId } from 'class-validator';

export class SyncDto {
  @IsMongoId()
  projectId: string;

  @IsNumber()
  @IsOptional()
  repoIndex?: number;
}
