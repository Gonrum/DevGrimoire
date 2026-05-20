import { IsString, Length, Matches } from 'class-validator';

/**
 * Canonical SHA-256 fingerprint form used here and returned by the test
 * endpoint: 32 colon-separated hex bytes, lowercase, exactly 95 chars.
 *
 *   aa:bb:cc:dd:ee:ff:00:11:22:33:44:55:66:77:88:99:aa:bb:cc:dd:ee:ff:00:11:22:33:44:55:66:77:88:99
 *
 * We deliberately fix the format on the API boundary so the stored value
 * matches byte-for-byte what we recompute on every reconnect — no
 * canonicalization needed at compare time.
 */
export const SSH_FINGERPRINT_REGEX = /^[0-9a-f]{2}(?::[0-9a-f]{2}){31}$/;

export class AcceptFingerprintDto {
  @IsString()
  @Length(95, 95, { message: 'fingerprint must be exactly 95 chars (32 hex bytes colon-separated)' })
  @Matches(SSH_FINGERPRINT_REGEX, {
    message: 'fingerprint must be 32 colon-separated lowercase hex bytes',
  })
  fingerprint: string;
}
