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
  const parsed = requireHttpsUrl(server);
  return { url: `https://127.0.0.1:${localPort}`, servername: parsed.hostname };
}

/**
 * Parst eine Cluster-Server-URL und besteht auf `https`.
 *
 * Beides ist nötig, und beides war es nicht: `new URL('')` wirft einen
 * TypeError, der als HTTP 500 beim Aufrufer landet statt als 400 — und ein
 * `http://…`-Server legt `Authorization: Bearer <token>` im Klartext auf die
 * Leitung. Die https-Prüfung stand bisher nur in `rewriteServerUrl()`, also
 * ausschliesslich auf dem Tunnel-Pfad; `direct` reichte durch, was in der
 * Kubeconfig stand.
 */
export function requireHttpsUrl(server: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(server);
  } catch {
    throw new BadRequestException(
      `Cluster-Server ist keine gültige URL: ${server || '(leer)'}`,
    );
  }
  if (parsed.protocol !== 'https:') {
    throw new BadRequestException('Cluster-Server muss https verwenden');
  }
  return parsed;
}

/**
 * Löst die Verbindung zu einem Kube-Cluster auf: entweder unverändert
 * (`direct`) oder über einen gecachten SSH-Tunnel (`ssh-tunnel`). Mehrere
 * gleichzeitige `resolve()`-Aufrufe für denselben Cluster teilen sich einen
 * Tunnel per Refcount; der Tunnel wird erst geschlossen, wenn der letzte
 * Halter freigegeben hat und die Idle-TTL abgelaufen ist.
 *
 * Gecacht wird der **Promise**, nicht erst das aufgelöste Ergebnis (Fix
 * Review-Runde 1): `this.tunnels.get(key)` und `this.tunnels.set(key, …)`
 * lägen sonst auf verschiedenen Seiten eines `await` — zwei gleichzeitige
 * `resolve()`-Aufrufe für denselben, noch ungecachten Cluster sähen beide
 * "nichts gecacht" und öffneten beide einen echten SSH-Tunnel; der zuletzt
 * schreibende gewinnt den Map-Slot, der andere Tunnel bliebe für immer
 * offen und unerreichbar. Weil der Promise synchron gecacht wird, bevor
 * überhaupt ein `await` läuft, sieht ein zweiter, im selben Tick gestarteter
 * Aufruf garantiert den bereits gecachten Promise.
 */
@Injectable()
export class KubeTransportService {
  private readonly tunnels = new Map<string, Promise<TunnelEntry>>();
  private readonly idleTtlMs: number;

  constructor(
    private readonly sshSessionService: SshSessionService,
    @Optional() opts?: { idleTtlMs?: number },
  ) {
    this.idleTtlMs = opts?.idleTtlMs ?? DEFAULT_IDLE_TTL_MS;
  }

  async resolve(cluster: KubeClusterDocument): Promise<ResolvedEndpoint> {
    if (cluster.transport === 'direct') {
      // Auch der direkte Pfad muss https erzwingen — sonst geht der
      // Bearer-Token im Klartext raus. `create()` lehnt das bereits beim
      // Anlegen ab; das hier ist die zweite Verteidigungslinie für
      // Bestandsdaten, die vor dieser Prüfung angelegt wurden.
      const parsed = requireHttpsUrl(cluster.clusterServer);
      return { url: cluster.clusterServer, servername: parsed.hostname, release: () => {} };
    }

    if (!cluster.sshConnectionId) {
      throw new BadRequestException('sshConnectionId fehlt für transport="ssh-tunnel"');
    }

    const key = String(cluster._id);
    const sshConnectionId = cluster.sshConnectionId.toString();
    // Bewusst nur die URL-Form prüfen, nicht das Protokoll: die
    // https-Prüfung bleibt auf diesem Pfad in `rewriteServerUrl()`, NACH dem
    // Öffnen des Tunnels — genau dort sitzt die Regression aus Review-Runde 1
    // (Refcount-Leak beim späten Wurf), und die soll erreichbar bleiben.
    let target: URL;
    try {
      target = new URL(cluster.clusterServer);
    } catch {
      throw new BadRequestException(
        `Cluster-Server ist keine gültige URL: ${cluster.clusterServer || '(leer)'}`,
      );
    }
    const dstPort = target.port ? Number(target.port) : 443;

    let entryPromise = this.tunnels.get(key);
    if (!entryPromise) {
      entryPromise = this.sshSessionService
        // Der vierte Parameter ist die Bruchmeldung: stirbt der SSH-Client
        // (Bastion-Reboot, sshd-Restart, Netz-Flap), verwirft der Listener
        // sich selbst und sagt hier Bescheid, damit der Cache-Eintrag
        // verschwindet statt auf einen toten Tunnel zu zeigen.
        .openTunnel(sshConnectionId, target.hostname, dstPort, () => { this.invalidate(key); })
        .then((opened): TunnelEntry => ({ localPort: opened.localPort, refs: 0, close: opened.close }));
      this.tunnels.set(key, entryPromise);
      // Schlägt das Öffnen fehl, darf der Key nicht dauerhaft mit einem
      // abgelehnten Promise belegt bleiben — sonst könnte kein späterer
      // Aufruf je wieder einen Tunnel für diesen Cluster aufbauen. Nur
      // löschen, wenn zwischenzeitlich kein neuerer Versuch den Slot bereits
      // übernommen hat.
      const pending = entryPromise;
      pending.catch(() => {
        if (this.tunnels.get(key) === pending) this.tunnels.delete(key);
      });
    }

    const entry = await entryPromise;

    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = undefined;
    }
    entry.refs += 1;

    // rewriteServerUrl() kann werfen (z.B. clusterServer ist kein https).
    // Schlägt sie fehl, bekommt dieser Aufrufer nie eine release()-Closure
    // zurück — der eben gesetzte Ref muss deshalb über denselben Pfad wie
    // ein normales release() zurückgenommen werden (Fix Review-Runde 1).
    // Ein bloßes "vor dem Increment validieren" reicht NICHT: bei einem
    // frisch geöffneten Tunnel (refs war 0) bliebe der Eintrag sonst für
    // immer mit refs=0 in der Map, ohne dass je ein closeNow eingeplant
    // wird — der Tunnel bliebe trotzdem offen, nur eben ohne
    // Refcount-Korruption. releaseEntry() enthält die einzige Stelle, die
    // "auf 0 gefallen → schließen" auslöst, daher muss auch dieser
    // Fehlerpfad dort durch.
    let endpoint: { url: string; servername: string };
    try {
      endpoint = rewriteServerUrl(cluster.clusterServer, entry.localPort);
    } catch (err) {
      this.releaseEntry(key, entryPromise, entry);
      throw err;
    }

    let released = false;
    return {
      url: endpoint.url,
      servername: endpoint.servername,
      release: () => {
        if (released) return; // doppeltes release darf fremde Refs nicht fressen
        released = true;
        // Schließt über den konkreten Promise/Entry, den dieser Aufruf
        // tatsächlich erhöht hat — nicht über einen erneuten Lookup per
        // Key. Ein erneuter Lookup würde bei gleichzeitigen Aufrufen den
        // jeweils aktuellen (u.U. fremden) Map-Eintrag treffen und dessen
        // Refcount statt des eigenen verändern.
        this.releaseEntry(key, entryPromise, entry);
      },
    };
  }

  /**
   * Wirft den gecachten Tunnel eines Clusters sofort weg — unabhängig vom
   * Refcount.
   *
   * Ohne diesen Weg leert sich der Cache ausschliesslich über „refs auf 0"
   * plus Idle-TTL. Das reicht nicht: mit K2s 2–5-Sekunden-Polling setzt jedes
   * `resolve()` den Idle-Timer zurück, ein veralteter Eintrag könnte also
   * unbegrenzt lange überleben. Drei Ereignisse machen einen Eintrag
   * veraltet, und alle drei rufen hier herein:
   *
   * - der SSH-Client stirbt (`onBroken` aus `openTunnel`) — der Listener
   *   davor ist wertlos;
   * - `update()` ändert `transport`/`sshConnectionId` — der Cluster tunnelte
   *   sonst bis zu eine Idle-TTL lang weiter über die ALTE Bastion;
   * - `delete()` entfernt den Cluster — Listener und ssh2-Client überlebten
   *   sonst die Entität.
   *
   * Bewusst hart: ein noch gehaltener Eintrag wird ebenfalls geschlossen. Bei
   * allen drei Anlässen ist er entweder schon tot oder zeigt aufs falsche
   * Ziel; ein laufender Request soll daran scheitern statt still das Falsche
   * zu tun.
   */
  invalidate(clusterId: string): void {
    const key = String(clusterId);
    const pending = this.tunnels.get(key);
    if (!pending) return;
    this.tunnels.delete(key);
    pending.then(
      (entry) => {
        if (entry.idleTimer) {
          clearTimeout(entry.idleTimer);
          entry.idleTimer = undefined;
        }
        entry.close();
      },
      () => {
        // Das Öffnen war ohnehin fehlgeschlagen — es gibt nichts zu
        // schliessen, und die Ablehnung ist hier bereits behandelt.
      },
    );
  }

  private releaseEntry(key: string, entryPromise: Promise<TunnelEntry>, entry: TunnelEntry): void {
    entry.refs -= 1;
    if (entry.refs > 0) return;
    const closeNow = () => {
      if (entry.refs > 0) return;
      entry.close();
      // Nur aus der Map nehmen, wenn dort noch genau dieser Tunnel hängt —
      // ein zwischenzeitlich neu geöffneter Tunnel für denselben Cluster
      // darf nicht durch das verspätete Aufräumen eines alten entfernt
      // werden.
      if (this.tunnels.get(key) === entryPromise) this.tunnels.delete(key);
    };
    if (this.idleTtlMs <= 0) {
      setImmediate(closeNow);
      return;
    }
    entry.idleTimer = setTimeout(closeNow, this.idleTtlMs);
    entry.idleTimer.unref();
  }
}
