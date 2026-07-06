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
    if (event.type === 'done' || event.type === 'error') {
      s.complete();
      setTimeout(() => { this.subjects.delete(jobId); this.cancelled.delete(jobId); }, 30_000).unref();
    }
  }

  subscribe(jobId: string): Observable<RelayEvent> { return this.subjectFor(jobId).asObservable(); }

  /** Signal a client disconnect so the worker can abort the upstream call. */
  cancel(jobId: string): void { this.cancelled.add(jobId); }
  isCancelled(jobId: string): boolean { return this.cancelled.has(jobId); }
}
