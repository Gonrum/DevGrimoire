import {
  ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsMongoId, IsOptional,
  IsString, Matches, Max, MaxLength, Min, MinLength, ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export class KubePrometheusDto {
  @IsBoolean()
  enabled: boolean;

  @IsOptional() @IsString() @MaxLength(253)
  namespace?: string;

  @IsOptional() @IsString() @MaxLength(253)
  service?: string;

  @IsOptional() @IsInt() @Min(1) @Max(65535)
  port?: number;

  @IsOptional() @IsString() @MaxLength(200)
  path?: string;
}

export class CreateKubeClusterDto {
  @IsString() @MinLength(1) @MaxLength(120)
  label: string;

  @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, { message: 'slug muss kebab-case sein' })
  @MinLength(3) @MaxLength(60)
  slug: string;

  @IsOptional() @IsMongoId()
  projectId?: string;

  @IsOptional() @IsMongoId()
  customerId?: string;

  /** Vollständige Kubeconfig im Klartext. Wird verschlüsselt abgelegt und
   *  nie zurückgegeben. */
  @IsString() @MinLength(1) @MaxLength(512 * 1024)
  kubeconfig: string;

  @IsString() @MinLength(1) @MaxLength(253)
  contextName: string;

  @IsOptional() @IsString() @MaxLength(253)
  defaultNamespace?: string;

  @IsIn(['direct', 'ssh-tunnel'])
  transport: 'direct' | 'ssh-tunnel';

  @IsOptional() @IsMongoId()
  sshConnectionId?: string;

  @IsOptional() @IsBoolean()
  readOnly?: boolean;

  @IsOptional() @IsBoolean()
  allowMcpWrites?: boolean;

  @IsOptional() @IsBoolean()
  allowInsecureTls?: boolean;

  @IsOptional() @ValidateNested() @Type(() => KubePrometheusDto)
  prometheus?: KubePrometheusDto;

  @IsOptional() @IsString() @MaxLength(2000)
  description?: string;

  @IsOptional() @IsArray() @ArrayMaxSize(20) @IsString({ each: true })
  tags?: string[];
}
