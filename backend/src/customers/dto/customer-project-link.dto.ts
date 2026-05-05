import { IsArray, IsEnum, IsMongoId, IsOptional, IsString } from 'class-validator';
import { CustomerProjectLinkStatus } from '../schemas/customer-project-link.schema';

export class CreateCustomerProjectLinkDto {
  @IsMongoId()
  projectId: string;

  @IsOptional()
  @IsEnum(CustomerProjectLinkStatus)
  status?: CustomerProjectLinkStatus;

  @IsOptional()
  @IsString()
  role?: string;

  @IsOptional()
  @IsString()
  notes?: string;

  @IsOptional()
  @IsArray()
  @IsMongoId({ each: true })
  environmentIds?: string[];
}

export class UpdateCustomerProjectLinkDto {
  @IsOptional()
  @IsEnum(CustomerProjectLinkStatus)
  status?: CustomerProjectLinkStatus;

  @IsOptional()
  @IsString()
  role?: string;

  @IsOptional()
  @IsString()
  notes?: string;

  @IsOptional()
  @IsArray()
  @IsMongoId({ each: true })
  environmentIds?: string[];
}
