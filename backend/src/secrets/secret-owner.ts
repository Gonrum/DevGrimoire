/**
 * Ownership rule for stored secret references (monitoring `secretHeaders`,
 * `gitRepositories[].tokenSecretId`, …).
 *
 * Background jobs (healthcheck cron, commit sync) resolve these references
 * WITHOUT an actor, so the scope check in `SecretsService.findById` does not
 * run then. Without an ownership rule a user could point a reference at any
 * secret of the instance and let the job decrypt it and send it to a URL of
 * their choice. The reference must therefore belong to the referencing
 * entity's owner — checked on write and again on resolution.
 */

type IdLike = { toString(): string } | string | null | undefined;

export interface SecretOwnerRef {
  projectId?: IdLike;
  customerId?: IdLike;
  /**
   * Projects linked to `customerId`. A customer-bound owner (e.g. a health
   * check) may also reference project-only secrets of these projects — the UI
   * offers exactly those. Only meaningful together with `customerId`.
   */
  linkedProjectIds?: IdLike[];
}

const idOf = (v: IdLike): string | null => (v === null || v === undefined ? null : v.toString() || null);

/**
 * True when every axis set on the secret equals the same axis of `owner`.
 * A secret without any axis never matches (it belongs to nobody). A
 * project-only secret matches an owner with that project, a customer-only
 * secret an owner with that customer, a relation secret (both axes) needs both.
 */
export function secretBelongsTo(secret: SecretOwnerRef, owner: SecretOwnerRef): boolean {
  const sp = idOf(secret.projectId);
  const sc = idOf(secret.customerId);
  if (!sp && !sc) return false;
  if (sc && sc !== idOf(owner.customerId)) return false;
  if (sp && sp !== idOf(owner.projectId)) {
    // A project-only secret of a project linked to the owner's customer.
    const linked = !sc && idOf(owner.customerId) !== null
      && (owner.linkedProjectIds ?? []).some((id) => idOf(id) === sp);
    if (!linked) return false;
  }
  return true;
}
