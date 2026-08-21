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

/** GET /api/kube-clusters/:id/events?namespace=&involvedName=&involvedKind=&limit= */
export class EventsQueryDto {
  @IsOptional() @IsString() @MaxLength(253)
  namespace?: string;

  @IsOptional() @IsString() @MaxLength(253)
  involvedName?: string;

  /**
   * Zusammen mit `involvedName`: trennt gleichnamige Objekte verschiedener
   * Kinds. `@IsIn` statt freiem String — der Wert geht in einen
   * `fieldSelector`, und die Registry ist ohnehin die Menge, über die dieses
   * Modul sprechen kann.
   */
  @IsOptional() @IsIn([...KUBE_KINDS], { message: 'involvedKind ist kein unterstützter Ressourcentyp' })
  involvedKind?: string;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(500)
  limit?: number;
}
