import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { KUBE_KINDS } from '../kube-kinds';

/**
 * GET /api/kube-clusters/:id/resources?kind=&namespace=&labelSelector=&limit=
 *
 * `limit` folgt demselben Muster wie `KubeAuditQueryDto`: `@Type(() =>
 * Number)` wandelt `?limit=abc` zu `NaN`, `@IsInt()` lehnt das ab — kein
 * ungeprüfter Wert erreicht `KubeResourcesService.list()`.
 */
export class ListResourcesDto {
  @IsIn([...KUBE_KINDS], { message: 'kind ist kein unterstützter Ressourcentyp' })
  kind: string;

  @IsOptional() @IsString() @MaxLength(253)
  namespace?: string;

  @IsOptional() @IsString() @MaxLength(512)
  labelSelector?: string;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(500)
  limit?: number;
}

/** GET .../resources/:kind/:name, .../yaml, .../describe/:kind/:name — gemeinsamer Query-Anteil. */
export class ResourceParamsDto {
  @IsOptional() @IsString() @MaxLength(253)
  namespace?: string;
}

/** GET /api/kube-clusters/:id/events?namespace=&involvedName=&limit= */
export class EventsQueryDto {
  @IsOptional() @IsString() @MaxLength(253)
  namespace?: string;

  @IsOptional() @IsString() @MaxLength(253)
  involvedName?: string;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(500)
  limit?: number;
}
