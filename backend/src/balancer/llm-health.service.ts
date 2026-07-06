import { Injectable, Optional } from '@nestjs/common';

interface Circuit { failures: number; openUntil: number; }

@Injectable()
export class LlmHealthService {
  private readonly circuits = new Map<string, Circuit>();
  private readonly threshold = 3;
  private readonly cooldownMs = 30_000;

  constructor(@Optional() private readonly now: () => number = () => Date.now()) {}

  private get(id: string): Circuit {
    let c = this.circuits.get(id);
    if (!c) { c = { failures: 0, openUntil: 0 }; this.circuits.set(id, c); }
    return c;
  }

  isHealthy(id: string): boolean { return this.now() >= this.get(id).openUntil; }

  recordSuccess(id: string): void { const c = this.get(id); c.failures = 0; c.openUntil = 0; }

  recordFailure(id: string): void {
    const c = this.get(id);
    c.failures += 1;
    if (c.failures >= this.threshold) { c.openUntil = this.now() + this.cooldownMs; c.failures = 0; }
  }
}
