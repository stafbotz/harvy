import { randomUUID } from "node:crypto";
import {
  isAdaptiveActionId,
  type AdaptiveActionId,
} from "../core/action-policy.js";

export interface ActionOffer {
  token: string;
  ownerId: string;
  actions: AdaptiveActionId[];
  goal: string;
  taskId: string | null;
}

interface StoredOffer {
  offer: ActionOffer;
  expiresAt: number;
}

const DEFAULT_TTL_MS = 10 * 60 * 1000;

/** Tawaran tombol sesaat; sesi yang lahir darinya disimpan di tempat lain. */
export class ActionOfferStore {
  private readonly offers = new Map<string, StoredOffer>();

  constructor(
    private readonly ttlMs = DEFAULT_TTL_MS,
    private readonly now: () => number = () => Date.now(),
  ) {}

  set(
    ownerId: string,
    actions: AdaptiveActionId[],
    goal: string,
    taskId: string | null = null,
  ): ActionOffer {
    const cleanGoal = goal.trim().replaceAll(/\s+/g, " ").slice(0, 240);
    if (!cleanGoal) throw new Error("Tujuan tawaran tidak boleh kosong.");
    const offer: ActionOffer = {
      token: randomUUID().replaceAll("-", "").slice(0, 8),
      ownerId,
      actions: [...new Set(actions.filter(isAdaptiveActionId))].slice(0, 3),
      goal: cleanGoal,
      taskId,
    };
    this.offers.set(ownerId, {
      offer,
      expiresAt: this.now() + this.ttlMs,
    });
    return offer;
  }

  take(
    ownerId: string,
    token: string,
    action: string,
  ): ActionOffer | null {
    const stored = this.offers.get(ownerId);
    if (
      !stored ||
      stored.expiresAt <= this.now() ||
      stored.offer.token !== token ||
      !stored.offer.actions.includes(action as AdaptiveActionId)
    ) {
      if (stored?.expiresAt && stored.expiresAt <= this.now()) {
        this.offers.delete(ownerId);
      }
      return null;
    }

    // Satu tawaran hanya boleh dipakai sekali; double-click menjadi no-op.
    this.offers.delete(ownerId);
    return stored.offer;
  }

  clear(ownerId: string): void {
    this.offers.delete(ownerId);
  }
}
