import { KubeConfig } from '@kubernetes/client-node';

export type KubeconfigWarning = 'insecure_tls' | 'no_ca';
export type KubeconfigRejection = 'exec_plugin' | 'auth_provider' | 'no_contexts' | 'unparsable';

export interface ParsedKubeContext {
  contextName: string;
  clusterName: string;
  server: string;
  userName: string;
  namespace?: string;
  warnings: KubeconfigWarning[];
  rejections: KubeconfigRejection[];
}

export interface ParsedKubeconfig {
  contexts: ParsedKubeContext[];
  currentContext?: string;
}

/**
 * Parst eine Kubeconfig und liefert ausschliesslich Metadaten — nie
 * Credentials. Der Rückgabewert geht 1:1 an den Browser, deshalb ist die
 * Auswahl der Felder hier eine Sicherheitsgrenze, keine Bequemlichkeit.
 */
export function parseKubeconfig(raw: string): ParsedKubeconfig {
  const kc = new KubeConfig();
  try {
    kc.loadFromString(raw);
  } catch {
    throw new Error('unparsable');
  }

  const contexts = kc.getContexts().map((ctx): ParsedKubeContext => {
    const cluster = kc.getCluster(ctx.cluster);
    const user = kc.getUser(ctx.user);
    const warnings: KubeconfigWarning[] = [];
    const rejections: KubeconfigRejection[] = [];

    if (cluster?.skipTLSVerify === true) warnings.push('insecure_tls');
    if (!cluster?.caData && !cluster?.caFile) warnings.push('no_ca');
    if (user?.exec) rejections.push('exec_plugin');
    if (user?.authProvider) rejections.push('auth_provider');

    return {
      contextName: ctx.name,
      clusterName: ctx.cluster,
      server: cluster?.server ?? '',
      userName: ctx.user,
      namespace: ctx.namespace,
      warnings,
      rejections,
    };
  });

  if (contexts.length === 0) throw new Error('unparsable');

  return { contexts, currentContext: kc.getCurrentContext() || undefined };
}
