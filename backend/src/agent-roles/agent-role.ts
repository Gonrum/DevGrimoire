/**
 * Spezialisierte Agent-Persona für Chat/Workflow/Review-Aufgaben (T-264).
 * Built-in-Rollen werden statisch definiert; pro Rolle können Prompt-Prefix,
 * Tool-Allowlist (intersected mit Caller-Allowlist), Output-Format-Hints und
 * Review-Kriterien hinterlegt werden.
 */
export interface AgentRole {
  /** Stable, kebab-case identifier — used as API key. */
  id: string;
  /** Anzeige-Name für UI/Listen. */
  name: string;
  /** Kurzbeschreibung des Einsatzzwecks. */
  description: string;
  /** Wird als prefix vor den normalen System-Prompt gehängt. */
  systemPromptPrefix: string;
  /**
   * Tool-Allowlist dieser Rolle. Wird mit der globalen/per-Key-Allowlist
   * geschnitten — eine Rolle kann also keine Tools freischalten, die der
   * Caller nicht ohnehin nutzen darf.
   */
  allowedTools: string[];
  /** Format-Vorgabe für die Antwort (z.B. "JSON-Liste mit findings[]"). */
  outputFormatHint?: string;
  /** Review-/Done-Kriterien, die diese Rolle bei Reviews durchsetzt. */
  reviewCriteria?: string[];
  /**
   * Defensive Constraints. Wird ebenfalls in den System-Prompt eingewoben,
   * damit das Modell die Regel direkt sieht und nicht nur indirekt über die
   * fehlende Tool-Allowlist eingeschränkt ist.
   */
  hardConstraints?: string[];
  /** Built-in (kann nicht gelöscht/editiert werden über die Standard-API). */
  builtIn: true;
}
