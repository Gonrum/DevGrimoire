export type ConditionOp =
  | 'eq' | 'ne' | 'gt' | 'lt' | 'gte' | 'lte'
  | 'contains' | 'exists' | 'truthy';

export function evalOp(lhs: unknown, op: ConditionOp, rhs?: unknown): boolean {
  switch (op) {
    case 'eq': return lhs === rhs;
    case 'ne': return lhs !== rhs;
    case 'gt':
      return typeof lhs === 'number' && typeof rhs === 'number' && lhs > rhs;
    case 'lt':
      return typeof lhs === 'number' && typeof rhs === 'number' && lhs < rhs;
    case 'gte':
      return typeof lhs === 'number' && typeof rhs === 'number' && lhs >= rhs;
    case 'lte':
      return typeof lhs === 'number' && typeof rhs === 'number' && lhs <= rhs;
    case 'contains':
      if (typeof lhs === 'string' && typeof rhs === 'string') return lhs.includes(rhs);
      if (Array.isArray(lhs)) return lhs.includes(rhs);
      return false;
    case 'exists':
      return lhs !== undefined && lhs !== null;
    case 'truthy':
      return Boolean(lhs);
    default:
      return false;
  }
}
