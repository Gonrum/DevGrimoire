export type PromotedEntityType =
  | 'knowledge'
  | 'snippet'
  | 'todo'
  | 'research'
  | 'manual';

export interface PromotedRef {
  entityType: PromotedEntityType;
  entityId: string;
  projectId?: string;
  customerId?: string;
}

export interface Note {
  _id: string;
  userId: string;
  title: string;
  content: string;
  order: number;
  archived: boolean;
  archivedAt?: string;
  promotedTo?: PromotedRef;
  idleSnoozeUntil?: string;
  promotionAttempts: number;
  createdAt: string;
  updatedAt: string;
  isIdle: boolean;
}

export interface PromotionProposal {
  entityType: PromotedEntityType;
  projectId: string | null;
  customerId: string | null;
  title: string;
  tags?: string[];
  reasoning?: string;
}

export interface PromotionCommitInput {
  entityType: PromotedEntityType;
  projectId?: string;
  customerId?: string;
  title: string;
  tags?: string[];
  reasoning?: string;
}

export interface PromotionCommitResult {
  promotedTo: PromotedRef;
  entityLink: string;
}
