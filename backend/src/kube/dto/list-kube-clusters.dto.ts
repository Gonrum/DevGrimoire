import { IsMongoId, IsOptional } from 'class-validator';

export class ListKubeClustersDto {
  @IsOptional() @IsMongoId()
  projectId?: string;

  @IsOptional() @IsMongoId()
  customerId?: string;
}
