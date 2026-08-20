import {
  ArrayMaxSize, IsArray, IsBoolean, IsIn, IsMongoId, IsOptional,
  IsString, MaxLength, MinLength, ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { KubePrometheusDto } from './create-kube-cluster.dto';

/**
 * Patch metadata only. `kubeconfig`, `slug`, `projectId` und `customerId`
 * sind absichtlich nicht enthalten: Scope und Slug sind unveränderlich, ein
 * neuer Zugang (rotierte Kubeconfig) wird über einen neuen Cluster angelegt.
 */
export class UpdateKubeClusterDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(120)
  label?: string;

  @IsOptional() @IsString() @MaxLength(253)
  defaultNamespace?: string;

  @IsOptional() @IsIn(['direct', 'ssh-tunnel'])
  transport?: 'direct' | 'ssh-tunnel';

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
