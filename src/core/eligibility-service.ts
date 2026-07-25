import type {
  AiConsentStatus,
  EligibilityRepository,
  EligibilityStatus,
} from "../domain/user-profile.js";

export class EligibilityService {
  constructor(private readonly repository: EligibilityRepository) {}

  async getStatus(ownerId: string): Promise<EligibilityStatus | null> {
    return (await this.repository.find(ownerId))?.status ?? null;
  }

  async setStatus(
    ownerId: string,
    status: EligibilityStatus,
  ): Promise<void> {
    const existing = await this.repository.find(ownerId);
    if (status === "eligible" && existing?.aiConsent) {
      await this.repository.save({
        ownerId,
        status,
        aiConsent: existing.aiConsent,
      });
      return;
    }

    await this.repository.save({ ownerId, status });
  }

  async clearStatus(ownerId: string): Promise<void> {
    await this.repository.delete(ownerId);
  }

  async getAiConsent(ownerId: string): Promise<AiConsentStatus | null> {
    return (await this.repository.find(ownerId))?.aiConsent ?? null;
  }

  async setAiConsent(
    ownerId: string,
    aiConsent: AiConsentStatus,
  ): Promise<void> {
    const existing = await this.repository.find(ownerId);
    if (existing?.status !== "eligible") {
      throw new Error("Persetujuan AI hanya tersedia untuk pengguna eligible.");
    }

    await this.repository.save({ ...existing, aiConsent });
  }

  async clearAiConsent(ownerId: string): Promise<void> {
    const existing = await this.repository.find(ownerId);
    if (!existing?.aiConsent) return;

    const { aiConsent: _removed, ...withoutConsent } = existing;
    await this.repository.save(withoutConsent);
  }
}
