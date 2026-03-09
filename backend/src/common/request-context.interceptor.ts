import { Injectable, NestInterceptor, ExecutionContext, CallHandler } from '@nestjs/common';
import { Observable } from 'rxjs';
import { RequestContext } from './request-context';

@Injectable()
export class RequestContextInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const req = context.switchToHttp().getRequest();
    const user = req.user;
    return new Observable((subscriber) => {
      RequestContext.run(user, () => {
        next.handle().subscribe(subscriber);
      });
    });
  }
}
