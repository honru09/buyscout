// Listing sources. The watcher only talks to the ListingSource interface,
// so a real marketplace feed can replace the local demo catalog later.

import type { Listing } from "./types.ts";
import { round2 } from "./store.ts";

export interface ListingSource {
  list(): Listing[];
  setPrice(id: string, price: number): Listing | null;
}

// Demo catalog with a price simulator: prices can be dropped on demand
// (through the /api/simulate/price endpoint or the UI button) so the
// watch -> hit -> buy flow can be shown live.
export class LocalCatalog implements ListingSource {
  private items: Listing[];

  constructor() {
    this.items = [
      { id: "lst_xm5", title: "Sony WH-1000XM5 Wireless Noise Cancelling Headphones", seller: "SoundHub", price: 149.0, currency: "USD" },
      { id: "lst_switch2", title: "Nintendo Switch 2 Console", seller: "GameDepot", price: 449.0, currency: "USD" },
      { id: "lst_kindle", title: "Kindle Paperwhite (16 GB) - Waterproof e-reader", seller: "BookBarn", price: 159.99, currency: "USD" },
      { id: "lst_lego", title: "LEGO Icons Bonsai Tree Set 10281", seller: "BrickWorld", price: 59.99, currency: "USD" },
      { id: "lst_airpods", title: "Apple AirPods Pro (2nd generation) with MagSafe Case", seller: "SoundHub", price: 189.0, currency: "USD" },
      { id: "lst_desk", title: "Standing Desk Frame (Electric, Dual Motor)", seller: "OfficeWorks", price: 329.0, currency: "USD" },
    ];
  }

  list(): Listing[] {
    return this.items.map((i) => ({ ...i }));
  }

  setPrice(id: string, price: number): Listing | null {
    const item = this.items.find((i) => i.id === id);
    if (!item) return null;
    item.price = round2(price);
    return { ...item };
  }

  // Best match = most keyword overlap with the title, ties broken by price.
  bestMatch(keywords: string[]): Listing | null {
    let best: Listing | null = null;
    let bestScore = 0;
    for (const item of this.items) {
      const title = item.title.toLowerCase();
      const score = keywords.filter((k) => title.includes(k)).length;
      if (score > bestScore || (score === bestScore && score > 0 && best && item.price < best.price)) {
        best = item;
        bestScore = score;
      }
    }
    return bestScore > 0 && best ? { ...best } : null;
  }
}
