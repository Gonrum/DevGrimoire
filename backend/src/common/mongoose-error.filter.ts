import { ArgumentsHost, Catch, ExceptionFilter, HttpStatus, Logger } from '@nestjs/common';
import type { Response } from 'express';
import { Error as MongooseError } from 'mongoose';

/**
 * T-510: Mongoose-Eingabefehler sind Fehler des Aufrufers, keine des Servers.
 *
 * Seit die Referenzfelder echte ObjectId-Pfade sind (vorher `Mixed`), lehnt
 * Mongoose eine ungültige Id in Filter oder Dokument ab: `CastError` in
 * Abfragen, `ValidationError` beim Speichern. Ohne diesen Filter würde daraus
 * HTTP 500 — vorher lief der Wert stumm durch und fand nichts bzw. wurde als
 * Müll gespeichert. MCP bildet dieselben Fehler schon in `mcp-errors.ts` ab.
 *
 * Die Antwort nennt nur Pfade, nie Werte (die könnten aus fremder Eingabe
 * stammen und landen sonst ungefiltert im Client).
 */
@Catch(MongooseError.CastError, MongooseError.ValidationError)
export class MongooseErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger(MongooseErrorFilter.name);

  catch(err: MongooseError.CastError | MongooseError.ValidationError, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    const message =
      err instanceof MongooseError.CastError
        ? `invalid_id: ${err.path} ist keine gültige Id`
        : `validation_failed: ${Object.keys(err.errors).join(', ')}`;
    this.logger.debug(`${message} (${err.message})`);
    if (res.headersSent) return;
    res.status(HttpStatus.BAD_REQUEST).json({ statusCode: HttpStatus.BAD_REQUEST, message, error: 'Bad Request' });
  }
}
