import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type RefreshTokenDocument = HydratedDocument<RefreshToken>;

@Schema({ timestamps: true })
export class RefreshToken {
  // SHA-256 (hex) des Tokens, NIE der Klartext — siehe hashRefreshToken() in
  // auth.service.ts (H-8). Der Feldname bleibt `token`, weil der bestehende
  // unique-Index darauf liegt: ein neues Feld liesse den alten Index auf
  // `token` zurück, und jedes neue Dokument ohne `token` kollidierte dort
  // als `null` (E11000).
  @Prop({ required: true })
  token: string;

  @Prop({ required: true })
  userId: string;

  @Prop({ required: true })
  expiresAt: Date;

  @Prop()
  ip: string;

  @Prop()
  userAgent: string;

  /**
   * Alle Tokens einer Login-Session teilen eine Familie (M-8). Wird ein
   * bereits rotiertes Token erneut vorgelegt, ist die Familie kompromittiert:
   * Angreifer und Nutzer halten verschiedene Zweige derselben Kette — dann
   * wird die ganze Familie widerrufen. Altbestand ohne Familie bleibt gültig
   * und bekommt bei der nächsten Rotation eine.
   */
  @Prop()
  familyId?: string;

  /** Gesetzt statt Löschen bei der Rotation — nur so ist ein Replay erkennbar. */
  @Prop()
  rotatedAt?: Date;

  // `timestamps: true` legt diese Felder zur Laufzeit an, deklariert sie aber
  // nicht am Typ — Leser brauchten dafür `as unknown as { createdAt?: Date }`.
  createdAt?: Date;
  updatedAt?: Date;
}

export const RefreshTokenSchema = SchemaFactory.createForClass(RefreshToken);
RefreshTokenSchema.index({ token: 1 }, { unique: true });
RefreshTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
RefreshTokenSchema.index({ familyId: 1 });
