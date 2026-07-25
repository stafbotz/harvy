import type {
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
    await this.repository.save({ ownerId, status });
  }

  async clearStatus(ownerId: string): Promise<void> {
    await this.repository.delete(ownerId);
  }
}
