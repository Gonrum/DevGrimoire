import {
  BadRequestException, Controller, ForbiddenException, Get, Put, Param, Body, UseGuards,
} from '@nestjs/common';
import { IsString, MaxLength } from 'class-validator';
import { SettingsService, isEncryptedSettingKey } from './settings.service';
import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { UserRole } from '../auth/schemas/user.schema';
import { actorHasPermission, Permission } from '../common/permissions';
import { RequestContext } from '../common/request-context';
import { AGENT_INSTRUCTIONS_KEY } from './default-agent-instructions';
import {
  NOTIFICATION_PUSH_CATEGORIES_KEY, NOTIFICATION_QUIET_HOURS_ENABLED_KEY,
  NOTIFICATION_QUIET_HOURS_FROM_KEY, NOTIFICATION_QUIET_HOURS_OVERRIDES_KEY,
  NOTIFICATION_QUIET_HOURS_TO_KEY,
} from '../notifications/notifications.service';
import {
  SETTING_CACHE_TTL_HOURS, SETTING_CONTENT_CACHE_TTL_DAYS, SETTING_DEFAULT_LANG,
  SETTING_ENABLED as WEB_SEARCH_ENABLED, SETTING_MAX_RESULTS,
} from '../web-search/services/web-search.service';
import { SETTING_SEARXNG_URL } from '../web-search/services/searxng-url.util';

/**
 * Keys, die die generische Route `PUT /api/settings/:key` schreiben darf (M-6).
 *
 * Genau die, die das Frontend über diese Route setzt (WebSearchSettings,
 * NotificationsSettings, InstructionsSettings). Alles andere hat einen eigenen,
 * validierenden Endpoint (Replikation, LLM-/Embedding-Endpoints, Chat, SSH,
 * Backups). Vorher nahm die Route jeden Key: ein Tippfehler legte eine Zeile
 * an, die nie jemand liest, und über sie liessen sich die verschlüsselten
 * Replikations-Keys an der Validierung ihres Endpoints vorbei überschreiben.
 * Wer hier ein neues Setting einführt, muss es eintragen — der 400 fällt dann
 * beim Bauen auf, nicht im Betrieb.
 */
export const GENERIC_WRITABLE_SETTING_KEYS: ReadonlySet<string> = new Set([
  WEB_SEARCH_ENABLED, SETTING_SEARXNG_URL, SETTING_DEFAULT_LANG,
  SETTING_CACHE_TTL_HOURS, SETTING_CONTENT_CACHE_TTL_DAYS, SETTING_MAX_RESULTS,
  NOTIFICATION_QUIET_HOURS_ENABLED_KEY, NOTIFICATION_QUIET_HOURS_FROM_KEY,
  NOTIFICATION_QUIET_HOURS_TO_KEY, NOTIFICATION_QUIET_HOURS_OVERRIDES_KEY,
  NOTIFICATION_PUSH_CATEGORIES_KEY,
  AGENT_INSTRUCTIONS_KEY,
]);

class SetSettingDto {
  // agent_instructions ist der längste Wert; 256 KB lassen dafür viel Luft.
  @IsString() @MaxLength(256 * 1024)
  value!: string;
}

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
  async set(@Param('key') key: string, @Body() body: SetSettingDto) {
    if (!GENERIC_WRITABLE_SETTING_KEYS.has(key)) {
      throw new BadRequestException(
        `Einstellung "${key.slice(0, 80)}" ist über diese Route nicht schreibbar (unbekannt oder mit eigenem Endpoint)`,
      );
    }
    const setting = await this.settingsService.set(key, body.value);
    if (isEncryptedSettingKey(key)) return { key: setting.key, value: setting.value ? '***' : null };
    return { key: setting.key, value: setting.value };
  }
}
