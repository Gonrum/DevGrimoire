import { Injectable, NotFoundException } from '@nestjs/common';
import { AgentRole } from './agent-role';
import { BUILT_IN_AGENT_ROLES } from './built-in-roles';

@Injectable()
export class AgentRolesService {
  findAll(): AgentRole[] {
    return [...BUILT_IN_AGENT_ROLES];
  }

  findById(id: string): AgentRole {
    const role = BUILT_IN_AGENT_ROLES.find((r) => r.id === id);
    if (!role) throw new NotFoundException(`Agent role "${id}" not found`);
    return role;
  }

  /**
   * Schneidet die Rollen-Allowlist mit der globalen Allowlist des Aufrufers.
   * Eine Rolle kann nichts freischalten, was der Caller nicht ohnehin darf.
   */
  intersectAllowedTools(roleId: string | undefined, callerAllowed: string[]): string[] {
    if (!roleId) return callerAllowed;
    const role = this.findById(roleId);
    const allowedSet = new Set(callerAllowed);
    return role.allowedTools.filter((t) => allowedSet.has(t));
  }

  /**
   * Baut den Rollen-Block, der vor den normalen System-Prompt gestellt wird.
   * Inkl. Hard-Constraints und Output-Format-Hints, damit das Modell die
   * Regeln explizit sieht.
   */
  buildRolePromptBlock(roleId: string | undefined): string {
    if (!roleId) return '';
    const role = this.findById(roleId);
    const constraints = role.hardConstraints?.length
      ? `\n\n**Harte Regeln (nicht verhandelbar):**\n${role.hardConstraints.map((c) => `- ${c}`).join('\n')}`
      : '';
    const format = role.outputFormatHint
      ? `\n\n**Antwort-Format:** ${role.outputFormatHint}`
      : '';
    return `# Aktive Rolle: ${role.name}\n${role.systemPromptPrefix}${constraints}${format}\n\n---\n\n`;
  }
}
