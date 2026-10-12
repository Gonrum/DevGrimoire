import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';
import {
  KUBE_NAME_LABEL_MAX,
  KUBE_NAME_LABEL_RE,
  KUBE_NAME_SUBDOMAIN_MAX,
  KUBE_NAME_SUBDOMAIN_RE,
} from '../kube-normalize';

/** `?follow=true` kommt als String an — Query-Parameter sind immer Strings. */
const toBool = () => Transform(({ value }: { value: unknown }) => value === 'true' || value === true);

/**
 * GET /api/kube-clusters/:id/logs/stream?namespace=&pod=&container=&tailLines=&previous=&follow=
 *
 * `@Matches` auf den drei Namensfeldern ist keine Kosmetik: `Log.log()` aus
 * `@kubernetes/client-node` interpoliert `namespace` und `pod` uncodiert in
 * den URL-Pfad (im Gegensatz zu jeder generierten API-Methode, die
 * `encodeURIComponent` nutzt). Ohne die Musterprüfung wird ein Wert wie
 * `default/../../../api/v1/namespaces/kube-system/secrets/foo?x=` zum Pfad-
 * bestandteil und liest ein beliebiges anderes Objekt aus dem Cluster —
 * vorbei an jeder Redaktion dieses Moduls. Siehe `kube-normalize.ts`
 * (KUBE_NAME_LABEL_RE) für die Herleitung.
 */
export class LogsQueryDto {
  @IsString() @MaxLength(KUBE_NAME_LABEL_MAX)
  @Matches(KUBE_NAME_LABEL_RE, { message: 'namespace ist kein gültiger Kubernetes-Namespace-Name (RFC 1123)' })
  namespace: string;

  @IsString() @MaxLength(KUBE_NAME_SUBDOMAIN_MAX)
  @Matches(KUBE_NAME_SUBDOMAIN_RE, { message: 'pod ist kein gültiger Kubernetes-Objektname (RFC 1123)' })
  pod: string;

  @IsOptional() @IsString() @MaxLength(KUBE_NAME_LABEL_MAX)
  @Matches(KUBE_NAME_LABEL_RE, { message: 'container ist kein gültiger Kubernetes-Containername (RFC 1123)' })
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
