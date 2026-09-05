import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AdaptiveActionId } from "../src/core/action-policy.js";
import {
  isOfferMuted,
  OFFER_IGNORE_LIMIT,
  OFFER_MUTE_MS,
  recordOfferTaken,
  recordOffersIgnored,
  withoutMutedOffers,
  type OfferFatigue,
} from "../src/core/offer-fatigue-policy.js";

const NOW = new Date("2026-09-04T00:00:00.000Z");

function abaikan(
  action: AdaptiveActionId,
  kali: number,
  now: Date = NOW,
): OfferFatigue {
  let fatigue: OfferFatigue = {};
  for (let index = 0; index < kali; index += 1) {
    fatigue = recordOffersIgnored(fatigue, [action], now);
  }
  return fatigue;
}

describe("kelelahan tawaran tindakan", () => {
  it("membiarkan tawaran yang belum pernah diabaikan", () => {
    assert.equal(isOfferMuted({}, "tutor", NOW), false);
    assert.equal(isOfferMuted(undefined, "tutor", NOW), false);
  });

  it("tidak mengistirahatkan sebelum batas terlampaui", () => {
    const fatigue = abaikan("tutor", OFFER_IGNORE_LIMIT - 1);
    assert.equal(isOfferMuted(fatigue, "tutor", NOW), false);
  });

  it("mengistirahatkan sesudah diabaikan berturut-turut", () => {
    const fatigue = abaikan("tutor", OFFER_IGNORE_LIMIT);
    assert.equal(isOfferMuted(fatigue, "tutor", NOW), true);
  });

  it("mengistirahatkan sementara, bukan selamanya", () => {
    const fatigue = abaikan("plan", OFFER_IGNORE_LIMIT);
    const sesudah = new Date(NOW.getTime() + OFFER_MUTE_MS + 1);
    assert.equal(isOfferMuted(fatigue, "plan", sesudah), false);
  });

  it("tidak pernah mengistirahatkan jalan ke bantuan manusia", () => {
    // Pasal 3 revisi v0.3: pengarahan ke bantuan manusia tidak boleh hilang
    // justru dari orang yang paling sering melewatinya.
    const fatigue = abaikan("human_bridge", OFFER_IGNORE_LIMIT * 5);
    assert.equal(isOfferMuted(fatigue, "human_bridge", NOW), false);
    assert.deepEqual(fatigue, {});
  });

  it("tidak pernah mengistirahatkan pintu kendali data", () => {
    const fatigue = abaikan("data_controls", OFFER_IGNORE_LIMIT * 5);
    assert.equal(isOfferMuted(fatigue, "data_controls", NOW), false);
  });

  it("melupakan seluruh catatan begitu tawaran benar-benar dipakai", () => {
    const fatigue = abaikan("tutor", OFFER_IGNORE_LIMIT);
    assert.equal(isOfferMuted(fatigue, "tutor", NOW), true);

    const sesudahDipakai = recordOfferTaken(fatigue, "tutor");
    assert.equal(isOfferMuted(sesudahDipakai, "tutor", NOW), false);
    assert.equal("tutor" in sesudahDipakai, false);
  });

  it("hanya membuang, tidak pernah menambah", () => {
    const fatigue = abaikan("tutor", OFFER_IGNORE_LIMIT);
    const disaring = withoutMutedOffers(["tutor", "plan"], fatigue, NOW);
    assert.deepEqual(disaring, ["plan"]);
    assert.deepEqual(withoutMutedOffers([], fatigue, NOW), []);
  });

  it("tidak mengubah catatan yang diberikan", () => {
    const asli: OfferFatigue = { tutor: { ignored: 1, mutedUntil: null } };
    const salinan = structuredClone(asli);
    recordOffersIgnored(asli, ["tutor"], NOW);
    recordOfferTaken(asli, "tutor");
    assert.deepEqual(asli, salinan);
  });

  it("menghitung tiap tawaran secara terpisah", () => {
    let fatigue: OfferFatigue = {};
    for (let index = 0; index < OFFER_IGNORE_LIMIT; index += 1) {
      fatigue = recordOffersIgnored(fatigue, ["tutor"], NOW);
    }
    fatigue = recordOffersIgnored(fatigue, ["plan"], NOW);

    assert.equal(isOfferMuted(fatigue, "tutor", NOW), true);
    assert.equal(isOfferMuted(fatigue, "plan", NOW), false);
  });

  it("mengabaikan stempel waktu yang rusak alih-alih membisukan selamanya", () => {
    const rusak: OfferFatigue = { tutor: { ignored: 0, mutedUntil: "bukan tanggal" } };
    assert.equal(isOfferMuted(rusak, "tutor", NOW), false);
  });
});
