export type EligibilityStatus = "eligible" | "ineligible";
export type AiConsentStatus = "granted" | "declined";

export interface EligibilityRecord {
  ownerId: string;
  status: EligibilityStatus;
  aiConsent?: AiConsentStatus;
}

export interface EligibilityRepository {
  find(ownerId: string): Promise<EligibilityRecord | null>;
  save(record: EligibilityRecord): Promise<void>;
  delete(ownerId: string): Promise<void>;
}
