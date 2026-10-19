/**
 * Muss ein aktiver Workflow mit `ssh.exec` neu aktiviert werden?
 *
 * Zeitplan- und Event-Läufe laufen im Namen dessen, der die **letzte**
 * Freigabe erteilt hat. Fehlt sie ganz (Altbestand, vor den Approvals
 * aktiviert) oder trägt sie keinen Nutzer, hat der Lauf keinen Akteur und
 * `ssh.exec` scheitert mit `no_accountable_user` — der Hinweis muss in beiden
 * Fällen erscheinen, nicht nur beim Approval ohne Nutzer.
 *
 * Importfrei, damit `scripts/workflow-reactivation-check.cjs` die Datei
 * einzeln übersetzen kann.
 */
export interface ReactivationInput {
  status?: string;
  approvals?: ReadonlyArray<{ approvedByUserId?: string }>;
}

export function needsSshReactivation(workflow: ReactivationInput | null | undefined, hasSshExec: boolean): boolean {
  if (!workflow || workflow.status !== 'active' || !hasSshExec) return false;
  const approvals = workflow.approvals ?? [];
  const latest = approvals.length > 0 ? approvals[approvals.length - 1] : undefined;
  return !latest?.approvedByUserId;
}
