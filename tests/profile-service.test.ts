import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CONSENT_VERSION,
  emptyProfile,
  needsOnboarding,
  ProfileService,
  shouldAskStyle,
} from "../src/core/profile-service.js";
import type { ProfileRepository, UserProfile } from "../src/domain/profile.js";

const NOW = new Date("2026-07-26T10:00:00.000Z");

class MemoryProfileRepository implements ProfileRepository {
  private readonly profiles = new Map<string, UserProfile>();

  async find(ownerId: string): Promise<UserProfile | null> {
    return this.profiles.get(ownerId) ?? null;
  }

  async save(profile: UserProfile): Promise<void> {
    this.profiles.set(profile.ownerId, profile);
  }
}

function service(): { repository: MemoryProfileRepository; profiles: ProfileService } {
  const repository = new MemoryProfileRepository();
  return { repository, profiles: new ProfileService(repository, () => NOW) };
}

describe("status kenalan", () => {
  it("menganggap pengguna tanpa profil belum berkenalan", () => {
    assert.equal(needsOnboarding(emptyProfile("student")), true);
  });

  it("meminta persetujuan lagi hanya ketika versinya naik", () => {
    const profile: UserProfile = {
      ...emptyProfile("student"),
      consentVersion: CONSENT_VERSION,
      onboardedAt: NOW.toISOString(),
    };

    assert.equal(needsOnboarding(profile), false);
    assert.equal(
      needsOnboarding({ ...profile, consentVersion: CONSENT_VERSION - 1 }),
      true,
    );
  });

  it("tidak melihat riwayat atau memori sama sekali", async () => {
    const { profiles } = service();

    await profiles.acceptConsent("student");

    // Pengguna yang menghapus seluruh ingatannya bukan pengguna baru. Kalau
    // status kenalan ikut riwayat, memakai hak melupakan berubah menjadi
    // hukuman berupa perkenalan ulang.
    await profiles.forgetPersonal("student");
    assert.equal(await profiles.needsOnboarding("student"), false);
  });

  it("menyimpan waktu berkenalan sekali, tidak menimpanya", async () => {
    const { profiles, repository } = service();

    await profiles.acceptConsent("student");
    await repository.save({
      ...(await profiles.load("student")),
      onboardedAt: "2026-01-01T00:00:00.000Z",
    });
    await profiles.acceptConsent("student");

    assert.equal(
      (await profiles.load("student")).onboardedAt,
      "2026-01-01T00:00:00.000Z",
    );
  });
});

describe("preferensi gaya menemani", () => {
  it("baru pantas ditanyakan setelah perkenalan selesai", () => {
    assert.equal(shouldAskStyle(emptyProfile("student")), false);
    assert.equal(
      shouldAskStyle({
        ...emptyProfile("student"),
        onboardedAt: NOW.toISOString(),
      }),
      true,
    );
  });

  it("hanya ditanyakan sekali, dijawab atau tidak", async () => {
    const { profiles } = service();
    await profiles.acceptConsent("student");

    await profiles.markStyleAsked("student");

    assert.equal(shouldAskStyle(await profiles.load("student")), false);
  });

  it("dilupakan bersama hal lain tentang orangnya", async () => {
    const { profiles } = service();
    await profiles.acceptConsent("student");
    await profiles.rememberStyle("student", "listen");

    await profiles.forgetPersonal("student");
    const profile = await profiles.load("student");

    assert.equal(profile.stylePreference, null);
    // Yang tersisa adalah catatan persetujuannya, bukan catatan tentang dirinya.
    assert.equal(profile.consentVersion, CONSENT_VERSION);
  });
});
