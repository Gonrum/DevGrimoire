import { ArgumentMetadata, BadRequestException, Injectable, PipeTransform } from '@nestjs/common';

/**
 * Einzelne Query-Parameter, die als `string` deklariert sind, müssen auch
 * einer sein (M-2).
 *
 * `@Query('x') x?: string` hat den Metatyp `String` — die ValidationPipe
 * prüft solche Skalare nicht. Mit dem `extended`-Query-Parser (qs) wird aus
 * `?x[$ne]=a` ein Objekt, das unverändert in ein Mongo-Filterobjekt gerät:
 * Operator-Injection. Mit dem heutigen Express-5-Default (`simple`) kommt nur
 * `?x=a&x=b` als Array an — keine Injection, aber ebenfalls kein String.
 * Diese Pipe macht beides zu einem 400, unabhängig vom eingestellten Parser
 * und für jeden Controller, auch künftige.
 *
 * Greift nur bei benannten Query-Parametern mit Metatyp String; ganze
 * DTO-Objekte (`@Query() dto`) prüft weiter die ValidationPipe.
 */
@Injectable()
export class ScalarQueryPipe implements PipeTransform {
  transform(value: unknown, metadata: ArgumentMetadata): unknown {
    if (metadata.type !== 'query' || !metadata.data || metadata.metatype !== String) return value;
    if (value === undefined || typeof value === 'string') return value;
    throw new BadRequestException(`Query-Parameter "${metadata.data}" muss ein einzelner String sein`);
  }
}
