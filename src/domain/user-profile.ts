export type EligibilityStatus = "eligible" | "ineligible";

export interface EligibilityRecord {
  ownerId: string;
  status: EligibilityStatus;
}

export interface EligibilityRepository {
  find(ownerId: string): Promise<EligibilityRecord | null>;
  save(record: EligibilityRecord): Promise<void>;
  delete(ownerId: string): Promise<void>;
}
