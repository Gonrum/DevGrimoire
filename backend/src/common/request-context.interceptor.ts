import { Injectable, NestInterceptor, ExecutionContext, CallHandler } from '@nestjs/common';
import { Observable } from 'rxjs';
import { AuthRequest, RequestContext } from './request-context';

@Injectable()
export class RequestContextInterceptor implements NestInterceptor {
  /**
   * `Observable<unknown>` statt `Observable<any>`: der Interceptor reicht den
   * Antwortstrom nur durch und interessiert sich nie für dessen Inhalt. Mit
   * `any` wurde jeder Consumer dieses Rückgabewerts untypisiert.
   */
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<AuthRequest>();
    const user = req.user;
    const apiKey = req.apiKey;
    return new Observable((subscriber) => {
      RequestContext.run(user, apiKey, () => {
        next.handle().subscribe(subscriber);
      });
    });
  }
}
