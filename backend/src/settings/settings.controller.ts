import { Controller, ForbiddenException, Get, Put, Param, Body, UseGuards } from '@nestjs/common';
import { SettingsService, isEncryptedSettingKey } from './settings.service';
import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { UserRole } from '../auth/schemas/user.schema';
import { actorHasPermission, Permission } from '../common/permissions';
import { RequestContext } from '../common/request-context';

/**
 * Setting-Keys, die jeder authentifizierte Nutzer lesen darf. Alles andere
 * erfordert `admin:settings:manage`.
 *
 * Warum eine Allowlist und keine Denylist sensitiver Keys: `SettingsService`
 * hat keine Key-Registry, ein Admin (oder ein Replikations-Peer) kann also
 * jederzeit neue Keys anlegen. Eine Denylist wäre fail-open — jeder neu
 * dazukommende sensitive Key wäre sofort für alle lesbar, bis jemand daran
 * denkt, ihn einzutragen. Genau diese Ausfallrichtung hat im Projekt
 * wiederholt zu Befunden geführt (`projectScopeMode ?? 'all'`, fehlende
 * `@Roles` direkt neben gegateten Nachbar-Routen).
 *
 * Der Preis: wer ein neues Nutzer-Setting einführt, muss es hier eintragen,
 * sonst sieht die UI einen 403. Das ist die gewollte Richtung, weil der Fehler
 * dann laut beim Bauen der Funktion auffällt statt still im Betrieb.
 *
 * Die Liste deckt exakt die beiden Settings-Tabs ab, die NICHT admin-gegated
 * sind (`Settings.tsx`: `instructions`, `notifications`); die übrigen Tabs
 * (`websearch`, `replication`, `llmEndpoints`, `backups`, …) rendert die UI
 * nur für Admins.
 */
const USER_READABLE_KEY_PREFIXES: readonly string[] = [
  // NotificationsSettings.tsx: persönliche Quiet Hours und Push-Kategorien.
  'notification_',
  // InstructionsSettings.tsx: Agenten-Instruktionen (Lesepfad).
  'agent_instructions',
];

function isUserReadableKey(key: string): boolean {
  return USER_READABLE_KEY_PREFIXES.some(
    (prefix) => key === prefix || key.startsWith(prefix),
  );
}

@Controller('settings')
export class SettingsController {
  constructor(private readonly settingsService: SettingsService) {}

  /**
   * Warum hier nicht einfach dasselbe `@Roles(ADMIN)` wie bei `set()` steht:
   * die Route liefert auch die persönlichen Benachrichtigungseinstellungen und
   * die Agenten-Instruktionen an normale Nutzer. Ein Admin-Gate auf
   * Klassenebene würde beide Tabs für jeden Nicht-Admin brechen.
   *
   * Ungeprüft war die Route ein Klartext-Leak: unter `replication.peer.apiKey`
   * und `replication.slave.apiKey` liegen die API-Keys der Gegeninstanz
   * UNVERSCHLÜSSERT (replication.controller.ts schreibt sie roh über
   * `settingsService.set`). Jeder authentifizierte Nutzer — und jeder
   * `cv_`-Key beliebigen Scopes — konnte sie lesen und damit selbst
   * replizieren, also lesend und schreibend auf alle freigeschalteten Projekte
   * der Peer-Instanz zugreifen. Das Masking des offiziellen Konfig-Endpoints
   * (`slaveApiKey ? '***' : undefined`) war damit wirkungslos. Daneben liegen
   * hier die AES-GCM-Chiffrate der LLM- und Embedding-Endpoints inkl. IV und
   * Auth-Tag.
   *
   * `actorHasPermission` short-circuitet auf `role === 'admin'` und liefert
   * `false` für einen fehlenden Actor — dieselbe Ausfallrichtung wie
   * `RolesGuard`, der ohne Actor ebenfalls blockt (auch bei deaktivierter
   * Auth).
   */
  @Get(':key')
  async get(@Param('key') key: string) {
    if (!isUserReadableKey(key)) {
      const actor = RequestContext.getUser();
      if (!actorHasPermission(actor, Permission.ADMIN_SETTINGS_MANAGE)) {
        throw new ForbiddenException(
          'Diese Einstellung erfordert Admin-Rechte (admin:settings:manage)',
        );
      }
    }
    const value = await this.settingsService.get(key);
    // Verschlüsselt gespeicherte Keys (Replikations-API-Keys) gibt die
    // generische Route auch Admins nur maskiert zurück — wie der
    // Replikations-Konfig-Endpoint. Den Klartext braucht nur das Backend.
    if (isEncryptedSettingKey(key)) return { key, value: value ? '***' : null };
    return { key, value };
  }

  @Put(':key')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN)
  async set(@Param('key') key: string, @Body() body: { value: string }) {
    const setting = await this.settingsService.set(key, body.value);
    if (isEncryptedSettingKey(key)) return { key: setting.key, value: setting.value ? '***' : null };
    return { key: setting.key, value: setting.value };
  }
}
