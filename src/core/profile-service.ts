import type {
  ProfileRepository,
  StylePreference,
  UserProfile,
} from "../domain/profile.js";

/**
 * Versi ketentuan yang berlaku sekarang.
 *
 * Naikkan hanya ketika yang disetujui pengguna benar-benar berubah: penyedia
 * model, jenis data yang dikirim ke luar, atau apa yang disimpan. Memperhalus
 * kalimat perkenalan bukan alasan untuk meminta persetujuan ulang — Pasal 4
 * nomor 5 melarang penarikan dan pemberian izin dibuat merepotkan.
 */
export const CONSENT_VERSION = 1;

export function emptyProfile(ownerId: string): UserProfile {
  return {
    ownerId,
    consentVersion: 0,
    onboardedAt: null,
    stylePreference: null,
    styleAskedAt: null,
  };
}

/**
 * Pengguna yang belum pernah menyetujui ketentuan versi ini.
 *
 * Sengaja tidak melihat riwayat atau memori sama sekali. Pengguna yang menghapus
 * seluruh ingatannya bukan pengguna baru, dan pengguna lama yang belum pernah
 * ditanya tetap harus ditanya.
 */
export function needsOnboarding(profile: UserProfile): boolean {
  return profile.consentVersion < CONSENT_VERSION;
}

/**
 * Pertanyaan gaya menemani hanya pantas muncul setelah satu percakapan nyata.
 *
 * Ditanyakan di gerbang perkenalan, ia menjadi kuis sebelum pengguna sempat
 * merasakan apa pun. Ditanyakan berulang, ia menjadi gangguan. Karena itu
 * `styleAskedAt` menutup pertanyaannya untuk selamanya, dijawab atau tidak.
 */
export function shouldAskStyle(profile: UserProfile): boolean {
  return (
    profile.onboardedAt !== null &&
    profile.stylePreference === null &&
    profile.styleAskedAt === null
  );
}

/**
 * Mengurus status kenalan seorang pengguna.
 *
 * Seluruh metode menerima `ownerId`; batas isolasinya sama dengan tugas,
 * memori, dan riwayat.
 */
export class ProfileService {
  constructor(
    private readonly repository: ProfileRepository,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Profil yang tersimpan, atau profil kosong yang belum pernah ditulis. */
  async load(ownerId: string): Promise<UserProfile> {
    return (await this.repository.find(ownerId)) ?? emptyProfile(ownerId);
  }

  async needsOnboarding(ownerId: string): Promise<boolean> {
    return needsOnboarding(await this.load(ownerId));
  }

  async acceptConsent(ownerId: string): Promise<UserProfile> {
    const profile = await this.load(ownerId);
    const updated: UserProfile = {
      ...profile,
      consentVersion: CONSENT_VERSION,
      onboardedAt: profile.onboardedAt ?? this.now().toISOString(),
    };

    await this.repository.save(updated);
    return updated;
  }

  async rememberStyle(
    ownerId: string,
    style: StylePreference,
  ): Promise<UserProfile> {
    const profile = await this.load(ownerId);
    const updated: UserProfile = {
      ...profile,
      stylePreference: style,
      styleAskedAt: profile.styleAskedAt ?? this.now().toISOString(),
    };

    await this.repository.save(updated);
    return updated;
  }

  async markStyleAsked(ownerId: string): Promise<void> {
    const profile = await this.load(ownerId);
    if (profile.styleAskedAt) return;

    await this.repository.save({
      ...profile,
      styleAskedAt: this.now().toISOString(),
    });
  }

  /**
   * Melupakan yang bersifat tentang orangnya, menyisakan catatan persetujuan.
   *
   * "Lupakan semua tentang aku" berarti Harvy berhenti mengenal penggunanya,
   * bukan berarti pengguna kehilangan persetujuan yang sudah ia berikan dan
   * harus berkenalan dari awal.
   */
  async forgetPersonal(ownerId: string): Promise<void> {
    const profile = await this.load(ownerId);
    if (profile.stylePreference === null) return;

    await this.repository.save({ ...profile, stylePreference: null });
  }
}
