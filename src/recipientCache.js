/**
 * Hasil onWhatsApp per sesi (hanya di memori): nomor terdaftar diingat 24
 * jam, tidak terdaftar 6 jam, supaya pengiriman berulang tidak selalu
 * bertanya ke server WhatsApp.
 */
export const EXISTS_TTL_MS = 24 * 60 * 60 * 1000;
export const MISSING_TTL_MS = 6 * 60 * 60 * 1000;
export const MAX_ENTRIES = 50000;

export class RecipientCache {
  constructor({ now = () => Date.now() } = {}) {
    this.now = now;
    this.items = new Map();
  }

  get(number) {
    const item = this.items.get(number);

    if (!item) {
      return null;
    }

    if (item.until <= this.now()) {
      this.items.delete(number);

      return null;
    }

    return { exists: item.exists, jid: item.jid };
  }

  set(number, exists, jid = null) {
    if (this.items.size >= MAX_ENTRIES) {
      this.items.delete(this.items.keys().next().value);
    }

    this.items.set(number, { exists, jid, until: this.now() + (exists ? EXISTS_TTL_MS : MISSING_TTL_MS) });
  }
}
