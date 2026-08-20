import { BadRequestException, Injectable, Optional } from '@nestjs/common';
import { SshSessionService } from '../ssh/ssh-session.service';
import { KubeClusterDocument } from './schemas/kube-cluster.schema';

export interface ResolvedEndpoint {
  /** URL, mit der der HTTP-Client spricht. */
  url: string;
  /** Hostname für die TLS-SNI/Zertifikatsprüfung — bei Tunnel der echte Host. */
  servername: string;
  /** Gibt den Refcount frei. Immer im finally aufrufen. */
  release: () => void;
}

interface TunnelEntry {
  localPort: number;
  refs: number;
  close: () => void;
  idleTimer?: NodeJS.Timeout;
}

const DEFAULT_IDLE_TTL_MS = 5 * 60 * 1000;

/**
 * Schreibt die Cluster-URL auf den lokalen Tunnel-Port um und behält den
 * echten Hostnamen als `servername`. Genau das hält die Zertifikatsprüfung
 * intakt: der Tunnel schreibt nur um, wohin verbunden wird — nicht, welches
 * Zertifikat als gültig gilt. Der Tunnel ist Transport, kein Vertrauensbruch.
 */
export function rewriteServerUrl(
  server: string,
  localPort: number,
): { url: string; servername: string } {
  const parsed = new URL(server);
  if (parsed.protocol !== 'https:') {
    throw new BadRequestException('Cluster-Server muss https verwenden');
  }
  return { url: `https://127.0.0.1:${localPort}`, servername: parsed.hostname };
}

/**
 * Löst die Verbindung zu einem Kube-Cluster auf: entweder unverändert
 * (`direct`) oder über einen gecachten SSH-Tunnel (`ssh-tunnel`). Mehrere
 * gleichzeitige `resolve()`-Aufrufe für denselben Cluster teilen sich einen
 * Tunnel per Refcount; der Tunnel wird erst geschlossen, wenn der letzte
 * Halter freigegeben hat und die Idle-TTL abgelaufen ist.
 */
@Injectable()
export class KubeTransportService {
  private readonly tunnels = new Map<string, TunnelEntry>();
  private readonly idleTtlMs: number;

  constructor(
    private readonly sshSessionService: SshSessionService,
    @Optional() opts?: { idleTtlMs?: number },
  ) {
    this.idleTtlMs = opts?.idleTtlMs ?? DEFAULT_IDLE_TTL_MS;
  }

  async resolve(cluster: KubeClusterDocument): Promise<ResolvedEndpoint> {
    if (cluster.transport === 'direct') {
      const parsed = new URL(cluster.clusterServer);
      return { url: cluster.clusterServer, servername: parsed.hostname, release: () => {} };
    }

    if (!cluster.sshConnectionId) {
      throw new BadRequestException('sshConnectionId fehlt für transport="ssh-tunnel"');
    }

    const key = String(cluster._id);
    const target = new URL(cluster.clusterServer);
    const dstPort = target.port ? Number(target.port) : 443;

    let entry = this.tunnels.get(key);
    if (!entry) {
      const opened = await this.sshSessionService.openTunnel(
        cluster.sshConnectionId.toString(),
        target.hostname,
        dstPort,
      );
      entry = { localPort: opened.localPort, refs: 0, close: opened.close };
      this.tunnels.set(key, entry);
    }
    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = undefined;
    }
    entry.refs += 1;

    const { url, servername } = rewriteServerUrl(cluster.clusterServer, entry.localPort);
    let released = false;
    return {
      url,
      servername,
      release: () => {
        if (released) return; // doppeltes release darf fremde Refs nicht fressen
        released = true;
        this.releaseTunnel(key);
      },
    };
  }

  private releaseTunnel(key: string): void {
    const entry = this.tunnels.get(key);
    if (!entry) return;
    entry.refs -= 1;
    if (entry.refs > 0) return;
    const closeNow = () => {
      const current = this.tunnels.get(key);
      if (!current || current.refs > 0) return;
      current.close();
      this.tunnels.delete(key);
    };
    if (this.idleTtlMs <= 0) {
      setImmediate(closeNow);
      return;
    }
    entry.idleTimer = setTimeout(closeNow, this.idleTtlMs);
    entry.idleTimer.unref();
  }
}
