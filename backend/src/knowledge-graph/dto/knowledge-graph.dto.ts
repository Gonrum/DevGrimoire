import { Type } from 'class-transformer';
import {
  IsEnum,
  IsIn,
  IsMongoId,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { KG_ENTITY_TYPES, KG_RELATIONS, KgEntityType, KgRelation } from '../schemas/knowledge-graph-edge.schema';

export class KgEndpointDto {
  @IsIn([...KG_ENTITY_TYPES])
  entityType: KgEntityType;

  @IsString()
  entityId: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  label?: string;
}

export class CreateKgEdgeDto {
  @IsMongoId()
  projectId: string;

  @ValidateNested()
  @Type(() => KgEndpointDto)
  source: KgEndpointDto;

  @ValidateNested()
  @Type(() => KgEndpointDto)
  target: KgEndpointDto;

  @IsIn([...KG_RELATIONS])
  relation: KgRelation;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(10)
  weight?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  confidence?: number;

  @IsOptional()
  @IsEnum(['directed', 'undirected'])
  direction?: 'directed' | 'undirected';

  @IsOptional()
  @IsEnum(['system', 'agent', 'user'])
  createdBy?: 'system' | 'agent' | 'user';

  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}

export class ListKgEdgesDto {
  @IsOptional()
  @IsMongoId()
  projectId?: string;

  @IsOptional()
  @IsIn([...KG_ENTITY_TYPES])
  entityType?: KgEntityType;

  @IsOptional()
  @IsString()
  entityId?: string;

  @IsOptional()
  @IsIn([...KG_RELATIONS])
  relation?: KgRelation;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  limit?: number;
}

export class GraphQueryDto {
  @IsMongoId()
  projectId: string;

  @IsIn([...KG_ENTITY_TYPES])
  entityType: KgEntityType;

  @IsString()
  entityId: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  @Max(5)
  depth?: number;
}
