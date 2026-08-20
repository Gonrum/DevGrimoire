import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

/** `?follow=true` kommt als String an — Query-Parameter sind immer Strings. */
const toBool = () => Transform(({ value }: { value: unknown }) => value === 'true' || value === true);

/** GET /api/kube-clusters/:id/logs/stream?namespace=&pod=&container=&tailLines=&previous=&follow= */
export class LogsQueryDto {
  @IsString() @MaxLength(253)
  namespace: string;

  @IsString() @MaxLength(253)
  pod: string;

  @IsOptional() @IsString() @MaxLength(253)
  container?: string;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(5000)
  tailLines?: number;

  @IsOptional() @toBool() @IsBoolean()
  previous?: boolean;

  @IsOptional() @toBool() @IsBoolean()
  follow?: boolean;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(86400)
  sinceSeconds?: number;

  /**
   * Review-Fund (Critical 1, Task 5 Fix Round 1): `JwtAuthGuard` liest ein
   * JWT aus `?token=` und kopiert es in den Authorization-Header
   * (jwt-auth.guard.ts:144-154) — der Query-Parameter selbst bleibt aber im
   * Request stehen. Die globale `ValidationPipe` steht auf
   * `forbidNonWhitelisted: true`; ohne dieses Feld lehnt sie `?token=` als
   * unbekannt ab, BEVOR der Guard es je sieht — und `EventSource` (der
   * einzige Weg, wie ein Browser SSE konsumiert) kann keine Header setzen,
   * `?token=` ist also der einzige Weg, wie ein Browser diese Route
   * überhaupt authentifiziert aufruft. Vom Handler selbst ungenutzt: die
   * Auth ist zu dem Zeitpunkt schon gelaufen.
   */
  @IsOptional() @IsString()
  token?: string;
}
