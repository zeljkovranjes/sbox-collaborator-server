import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/**
 * AES-256-GCM for small secrets stored in the database (Discord webhook URLs). The key is derived
 * from SECRET_KEY, so the database alone is not enough to read them.
 */
export class SecretBox {
  readonly #key: Buffer;

  constructor(secretKey: string, purpose: string) {
    this.#key = createHash('sha256').update(`${purpose}\u0000${secretKey}`).digest();
  }

  seal(plain: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.#key, iv);
    const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return `v1.${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${data.toString('base64url')}`;
  }

  /** Returns null when the value cannot be decrypted (wrong key, tampered). */
  open(sealed: string | null | undefined): string | null {
    if (!sealed) return null;
    const [version, iv, tag, data] = sealed.split('.');
    if (version !== 'v1' || !iv || !tag || !data) return null;
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.#key, Buffer.from(iv, 'base64url'));
      decipher.setAuthTag(Buffer.from(tag, 'base64url'));
      return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
    } catch {
      return null;
    }
  }
}
