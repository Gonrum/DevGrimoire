import { Body, Controller, Get, Put, Post, Query, HttpCode } from '@nestjs/common';
import { RagService, EmbeddingEndpointInput } from './rag.service';
import { Roles } from '../auth/decorators/roles.decorator';
import { UserRole } from '../auth/schemas/user.schema';

@Controller('rag')
export class RagController {
  constructor(private readonly ragService: RagService) {}

  @Get('search')
  async search(
    @Query('query') query: string,
    @Query('projectId') projectId?: string,
    @Query('customerId') customerId?: string,
    @Query('entity') entity?: string,
    @Query('limit') limit?: string,
  ) {
    if (!query) throw new Error('Missing required query parameter: query');
    const results = await this.ragService.search(
      query,
      projectId || undefined,
      entity || undefined,
      limit ? parseInt(limit, 10) : 10,
      customerId || undefined,
    );
    return results;
  }

  /**
   * Admin-only — dieselbe Hürde wie `PUT config` direkt darunter.
   *
   * War ungegated und nimmt `projectId`/`customerId` als rohe Query-Strings.
   * Ohne Parameter droppt `reindex()` die komplette `documents`-Tabelle: jeder
   * authentifizierte Nutzer konnte damit den semantischen Index aller Projekte
   * löschen (Wiederaufbau = voller Re-Embed-Durchlauf, also LLM-Kosten und
   * stundenlang blindes `rag_search`). Dieselbe Route ist als MCP-Tool
   * `rag_reindex` exponiert und damit prompt-injizierbar.
   *
   * `docs/operations.md` weist `rag_reindex` als Standard-Operation nach einem
   * Embedding-Model-Wechsel aus — das ist eine Admin-Tätigkeit.
   */
  @Post('reindex')
  @Roles(UserRole.ADMIN)
  @HttpCode(200)
  async reindex(
    @Query('projectId') projectId?: string,
    @Query('customerId') customerId?: string,
  ) {
    return this.ragService.reindex(projectId || undefined, customerId || undefined);
  }

  @Get('status')
  async status(): Promise<Record<string, unknown>> {
    return this.ragService.status();
  }

  @Get('config')
  async getConfig() {
    const [endpoints, managedViaSettings, status] = await Promise.all([
      this.ragService.getEndpointsPublic(),
      this.ragService.isManagedViaSettings(),
      this.ragService.status(),
    ]);
    return { endpoints, managedViaSettings, status };
  }

  @Put('config')
  @Roles(UserRole.ADMIN)
  async setConfig(@Body() dto: { endpoints: EmbeddingEndpointInput[] }) {
    await this.ragService.setEndpoints(dto.endpoints ?? []);
    return this.getConfig();
  }

  /**
   * Admin-only — dieselbe Hürde wie `PUT config` direkt darüber.
   *
   * War ungegated und ist ein Outbound-Fetch an eine URL aus dem Request-Body:
   * `testEndpoint()` prüft nur Provider und Nicht-Leere, kein Schema und kein
   * Host. Ein Nicht-Admin konnte damit beliebige interne Ziele vom
   * Backend-Container aus anfragen (Cloud-Metadaten unter 169.254.169.254,
   * MongoDB/MinIO im Compose-Netz, der GPU-Host) und bekam über den
   * Fehlertext ein Leseorakel — der angehängte `/v1/embeddings`-Pfad lässt sich
   * über ein `#`-Fragment neutralisieren.
   *
   * Bewusst KEINE Private-IP-Blockade, obwohl `readability.service.ts` eine
   * vorbildliche `assertPublicHost`-Implementierung hat: Embedding-Endpoints
   * sind admin-konfigurierte Infrastruktur und liegen laut `.env.example`
   * regulär auf `http://localhost:11434`, `http://host.docker.internal:11434`,
   * `http://gpu:1234` oder `http://ollama:11434` — alles privat. Eine Sperre
   * würde die primäre dokumentierte Konfiguration (Default-Provider `ollama`)
   * abschalten. Der Schutz ist hier das Rollen-Gate: dass ein Admin das
   * Backend auf einen internen Host zeigt, ist der Zweck der Funktion.
   *
   * `@Body() dto: EmbeddingEndpointInput` ist ein Interface, die globale
   * ValidationPipe überspringt es also — ein echtes DTO mit class-validator
   * steht noch aus.
   */
  @Post('config/test')
  @Roles(UserRole.ADMIN)
  @HttpCode(200)
  async testConfig(@Body() dto: EmbeddingEndpointInput) {
    return this.ragService.testEndpoint(dto);
  }
}
