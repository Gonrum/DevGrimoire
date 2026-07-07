import { Injectable } from '@nestjs/common';
import { Observable, ReplaySubject } from 'rxjs';
import { RelayEvent } from './balancer.types';

@Injectable()
export class StreamRelay {
  private readonly subjects = new Map<string, ReplaySubject<RelayEvent>>();
  private readonly cancelled = new Set<string>();

  private subjectFor(jobId: string): ReplaySubject<RelayEvent> {
    let s = this.subjects.get(jobId);
    if (!s) { s = new ReplaySubject<RelayEvent>(); this.subjects.set(jobId, s); }
    return s;
  }

  publish(jobId: string, event: RelayEvent): void {
    const s = this.subjectFor(jobId);
    s.next(event);
    // Terminal events: chat streams end with `done`, the embed path ends with a
    // single atomic `result`, and any path can end with `error`. All three
    // complete the subject and schedule its removal — otherwise the per-job
    // ReplaySubject (embed's holds the full vector) leaks for the process
    // lifetime, and the hot RAG reindex/sync path grows memory unbounded.
    if (event.type === 'done' || event.type === 'error' || event.type === 'result') {
      s.complete();
      setTimeout(() => { this.subjects.delete(jobId); this.cancelled.delete(jobId); }, 30_000).unref();
    }
  }

  subscribe(jobId: string): Observable<RelayEvent> { return this.subjectFor(jobId).asObservable(); }

  /** Signal a client disconnect so the worker can abort the upstream call. */
  cancel(jobId: string): void { this.cancelled.add(jobId); }
  isCancelled(jobId: string): boolean { return this.cancelled.has(jobId); }
}
