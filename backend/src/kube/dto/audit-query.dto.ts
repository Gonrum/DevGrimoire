import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

/**
 * GET /api/kube-clusters/:id/audit?limit&offset
 *
 * Kein ungeprüfter Wert darf als Mongo limit()/skip() landen: `?limit=abc`
 * transformiert über `@Type(() => Number)` zu `NaN`, und `@IsInt()` lehnt
 * `NaN` ab (`Number.isInteger(NaN)` ist `false`) — die globale
 * `ValidationPipe` (whitelist/transform/forbidNonWhitelisted, main.ts)
 * antwortet dann mit 400 statt den Wert unverändert an
 * `KubeAuditService.list()` durchzureichen.
 */
export class KubeAuditQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number;
}
