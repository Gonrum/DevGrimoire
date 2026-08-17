import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { HarnessOwner, HarnessService } from './harness.service';
import { CreateHarnessDto } from './dto/create-harness.dto';
import { UpdateHarnessDto } from './dto/update-harness.dto';
import { HarnessSectionDto } from './dto/harness-section.dto';
import { HARNESS_SCOPES, HarnessScope, ResolvedHarness } from './harness.types';
import { pickAllowed } from '../common/narrow';
import { HarnessDocument } from './schemas/harness.schema';

/**
 * REST-Oberfläche der Harness-Definitionen (T-439, M-51/H1).
 *
 * Zwei Zugriffsarten, bewusst getrennt:
 *
 * - **roh** (`GET /api/harness?scope=…`) — genau eine Ebene, zum Bearbeiten.
 * - **aufgelöst** (`GET /api/harness/resolve/:projectId`) — das Ergebnis der
 *   Vererbung, zum Anwenden. Nur lesbar; wer etwas ändern will, ändert eine
 *   Ebene.
 *
 * Section-Operationen laufen über den Besitzer (`scope` + Owner-Id), nicht über
 * die Harness-Id: der Aufrufer kennt sein Projekt, nicht den Datensatz — und
 * `sectionSet` legt die Ebene beim ersten Schreiben ohnehin selbst an.
 */
@Controller('harness')
export class HarnessController {
  constructor(private readonly harnessService: HarnessService) {}

  /** Metadaten aller Ebenen, optional auf einen Scope eingegrenzt. */
  @Get('list')
  list(@Query('scope') scope?: string) {
    return this.harnessService.list(this.optionalScope(scope));
  }

  /**
   * Die aufgelöste Sicht: `sections[]`, `resolvedFrom[]`, `suppressed[]` und
   * das gerenderte `markdown`.
   */
  @Get('resolve/:projectId')
  resolve(@Param('projectId') projectId: string): Promise<ResolvedHarness> {
    return this.harnessService.resolve(projectId);
  }

  /**
   * Die rohe Ebene. Existiert sie nicht, ist das kein Fehler — eine Ebene wird
   * erst beim ersten Schreiben angelegt.
   *
   * Rückgabe dann `{}` und nicht `null`: Nest serialisiert `null` als **leeren
   * Body**, woran jedes `res.json()` im Frontend scheitert. Dieselbe Lösung wie
   * im Souls-Controller (`soul || {}`), und für den Aufrufer eindeutig — ein
   * echter Datensatz trägt immer `_id`.
   */
  @Get()
  async findByOwner(
    @Query('scope') scope?: string,
    @Query('projectId') projectId?: string,
    @Query('customerId') customerId?: string,
  ): Promise<HarnessDocument | Record<string, never>> {
    const harness = await this.harnessService.findByOwner(
      this.owner(scope, projectId, customerId),
    );
    return harness ?? {};
  }

  @Post()
  create(@Body() dto: CreateHarnessDto) {
    return this.harnessService.create(dto);
  }

  @Put(':id')
  update(@Param('id') id: string, @Body() dto: UpdateHarnessDto) {
    return this.harnessService.update(id, dto);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.harnessService.remove(id);
  }

  /**
   * Upsert einer einzelnen Section.
   *
   * Der Key steht in der URL **und** im Body; sie müssen übereinstimmen. Sonst
   * entscheidet stillschweigend der Body, und ein
   * `PUT …/sections/stil` mit `{"key": "ton"}` legt eine Section an, die der
   * Aufrufer nicht gemeint hat.
   */
  @Put('sections/:key')
  sectionSet(
    @Param('key') key: string,
    @Body() dto: HarnessSectionDto,
    @Query('scope') scope?: string,
    @Query('projectId') projectId?: string,
    @Query('customerId') customerId?: string,
  ) {
    if (dto.key !== key) {
      throw new BadRequestException(
        `Section key mismatch: '${key}' in the path, '${dto.key}' in the body`,
      );
    }
    return this.harnessService.sectionSet(this.owner(scope, projectId, customerId), dto);
  }

  @Delete('sections/:key')
  sectionDelete(
    @Param('key') key: string,
    @Query('scope') scope?: string,
    @Query('projectId') projectId?: string,
    @Query('customerId') customerId?: string,
  ) {
    return this.harnessService.sectionDelete(this.owner(scope, projectId, customerId), key);
  }

  /**
   * Query-Parameter → Besitzer.
   *
   * `pickAllowed` prüft und verengt in einem Schritt; ein `scope as HarnessScope`
   * hätte genau das behauptet, was zu prüfen ist. Ein unbekannter Wert ergibt
   * 400 mit der Liste der erlaubten Werte statt eines 500ers aus der Tiefe des
   * Services.
   */
  private owner(scope?: string, projectId?: string, customerId?: string): HarnessOwner {
    if (!scope) {
      throw new BadRequestException(
        `scope query parameter is required (one of: ${HARNESS_SCOPES.join(', ')})`,
      );
    }
    const valid = pickAllowed(HARNESS_SCOPES, scope);
    if (!valid) {
      throw new BadRequestException(
        `Invalid scope '${scope}' (one of: ${HARNESS_SCOPES.join(', ')})`,
      );
    }
    return { scope: valid, projectId, customerId };
  }

  private optionalScope(scope?: string): HarnessScope | undefined {
    if (!scope) return undefined;
    const valid = pickAllowed(HARNESS_SCOPES, scope);
    if (!valid) {
      throw new BadRequestException(
        `Invalid scope '${scope}' (one of: ${HARNESS_SCOPES.join(', ')})`,
      );
    }
    return valid;
  }
}
