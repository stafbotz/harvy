import { createHmac, randomUUID } from "node:crypto";
import {
  canonicalPlanId,
  PERSONAL_PLAN_IDS,
} from "../domain/control-plane.js";
import type {
  Cohort,
  ConfiguredModel,
  ConsoleAuditAction,
  ConsoleAuditRecord,
  ControlPlaneRepository,
  ControlPlaneState,
  Enrollment,
  EvaluationConsent,
  GroupRuntimeMode,
  ModelPriceRates,
  ModelPriceVersion,
  PlanAudience,
  PlanVersion,
  ScopedPrincipal,
  SubjectChannel,
  SubjectKind,
} from "../domain/control-plane.js";
import { usdDecimalToNanos, validUsdRate } from "./money.js";

const MAX_AUDIT_RECORDS = 10_000;

const PERSONAL_PLAN_SPECS = [
  {
    planId: PERSONAL_PLAN_IDS.free,
    publicName: "Perkenalan",
    legacyPublicName: "Gratis",
    monthlyPriceIdr: 0,
    capacityMultiplier: 1,
  },
  {
    planId: PERSONAL_PLAN_IDS.plus,
    publicName: "Toro",
    legacyPublicName: "Tunas",
    monthlyPriceIdr: 19_000,
    capacityMultiplier: 2,
  },
  {
    planId: PERSONAL_PLAN_IDS.pro,
    publicName: "Sora",
    legacyPublicName: "Mekar",
    monthlyPriceIdr: 39_000,
    capacityMultiplier: 5,
  },
  {
    planId: PERSONAL_PLAN_IDS.max,
    publicName: "Kuro",
    legacyPublicName: "Rimbun",
    monthlyPriceIdr: 69_000,
    capacityMultiplier: 10,
  },
] as const;

export interface PriceBootstrap {
  providerId: string;
  modelId: string;
  inputPerMillionUsd: string;
  outputPerMillionUsd: string;
}

export interface ControlPlaneOptions {
  fallbackRollingTokenLimit: number;
  betaQuotaMultiplier: number;
  configuredModels: readonly ConfiguredModel[];
  priceBootstraps?: readonly PriceBootstrap[];
}

export interface SubjectDescriptor {
  kind: SubjectKind;
  channel: SubjectChannel;
}

export interface EnrollmentPatch {
  operatorLabel?: string | null;
  cohort?: Cohort;
  planId?: string;
  quotaOverride?: number | null;
  betaExpiresAt?: string | null;
  groupRuntimeMode?: GroupRuntimeMode | null;
}

export interface NewPlanVersion {
  planId: string;
  publicName: string;
  audience: PlanAudience;
  monthlyPriceIdr: number;
  rolling24hTokenLimit: number;
  activeMemberLimit: number | null;
  groupMode: PlanVersion["groupMode"];
  status: PlanVersion["status"];
  effectiveFrom: string;
}

export interface NewPriceVersion {
  providerId: string;
  modelId: string;
  rates: ModelPriceRates;
  status: ModelPriceVersion["status"];
  effectiveFrom: string;
}

export class ControlPlaneConflictError extends Error {
  constructor(message = "Versi data sudah berubah.") {
    super(message);
    this.name = "ControlPlaneConflictError";
  }
}

export class ControlPlaneValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ControlPlaneValidationError";
  }
}

/**
 * Authority lokal untuk enrollment, paket, harga, principal scoped, dan audit.
 * Semua ID platform hanya dipakai sebagai input HMAC dan tidak disimpan.
 */
export class ControlPlaneService {
  private initialized: Promise<void> | null = null;
  private readonly configuredModels: ConfiguredModel[];
  private readonly configuredModelKeys: Set<string>;

  constructor(
    private readonly repository: ControlPlaneRepository,
    private readonly options: ControlPlaneOptions,
    private readonly now: () => Date = () => new Date(),
  ) {
    if (
      !Number.isSafeInteger(options.fallbackRollingTokenLimit) ||
      options.fallbackRollingTokenLimit < 0 ||
      !Number.isSafeInteger(options.betaQuotaMultiplier) ||
      options.betaQuotaMultiplier < 1
    ) {
      throw new Error("Konfigurasi control plane tidak sah.");
    }
    this.configuredModels = normalizeConfiguredModels(options.configuredModels);
    if (this.configuredModels.length === 0) {
      throw new Error("Konfigurasi control plane tidak mempunyai model.");
    }
    this.configuredModelKeys = new Set(
      this.configuredModels.map((model) =>
        priceKey(model.providerId, model.modelId)
      ),
    );
  }

  async initialize(): Promise<void> {
    this.initialized ??= this.seed();
    await this.initialized;
  }

  async dashboardState(): Promise<{
    plans: PlanVersion[];
    prices: ModelPriceVersion[];
    enrollments: Enrollment[];
    configuredModels: ConfiguredModel[];
  }> {
    await this.initialize();
    const state = await this.repository.snapshot();
    return {
      plans: sortByNewest(state.plans),
      prices: sortByNewest(state.prices),
      configuredModels: structuredClone(this.configuredModels),
      enrollments: [...state.enrollments].sort((left, right) =>
        right.updatedAt.localeCompare(left.updatedAt, "en"),
      ),
    };
  }

  async plans(): Promise<PlanVersion[]> {
    return (await this.dashboardState()).plans;
  }

  async prices(): Promise<ModelPriceVersion[]> {
    return (await this.dashboardState()).prices;
  }

  async enrollments(): Promise<Enrollment[]> {
    return (await this.dashboardState()).enrollments;
  }

  async audits(limit = 250): Promise<ConsoleAuditRecord[]> {
    await this.initialize();
    const state = await this.repository.snapshot();
    return [...state.audit]
      .sort((left, right) => right.at.localeCompare(left.at, "en"))
      .slice(0, Math.max(1, Math.min(1_000, Math.floor(limit))));
  }

  async subjectRef(
    ownerId: string,
    descriptor = describeOwner(ownerId),
  ): Promise<string> {
    await this.initialize();
    const state = await this.repository.snapshot();
    return subjectRefOf(state.installationKey, ownerId, descriptor);
  }

  async enrollmentForOwner(
    ownerId: string,
    descriptor = describeOwner(ownerId),
  ): Promise<Enrollment> {
    await this.initialize();
    const subjectRef = await this.subjectRef(ownerId, descriptor);
    return this.ensureEnrollment(subjectRef, descriptor);
  }

  async createEnrollmentFromExternal(
    externalId: string,
    descriptor: SubjectDescriptor,
    operatorLabel: string | null = null,
  ): Promise<Enrollment> {
    const clean = externalId.trim();
    if (!clean || clean.length > 256 || /[\u0000-\u001f]/u.test(clean)) {
      throw new ControlPlaneValidationError("ID subject tidak sah.");
    }
    const ownerId = descriptor.kind === "group" &&
      !clean.startsWith(`${descriptor.channel}:`)
      ? `${descriptor.channel}:${clean}`
      : clean;
    const subjectRef = await this.subjectRef(ownerId, descriptor);
    return this.ensureEnrollment(subjectRef, descriptor, operatorLabel);
  }

  async updateEnrollment(
    subjectRef: string,
    expectedVersion: number,
    patch: EnrollmentPatch,
  ): Promise<Enrollment> {
    await this.initialize();
    return this.repository.mutate((state) => {
      const enrollment = state.enrollments.find(
        (candidate) => candidate.subjectRef === subjectRef,
      );
      if (!enrollment) {
        throw new ControlPlaneValidationError("Enrollment tidak ditemukan.");
      }
      if (enrollment.version !== expectedVersion) {
        throw new ControlPlaneConflictError();
      }
      const at = this.now().toISOString();
      const operatorLabel = patch.operatorLabel === undefined
        ? enrollment.operatorLabel
        : cleanOperatorLabel(patch.operatorLabel);
      const cohort = patch.cohort ?? enrollment.cohort;
      const planId = canonicalPlanId(patch.planId ?? enrollment.planId);
      const plan = activePlan(state.plans, planId, at);
      if (!plan || !planMatchesSubject(plan, enrollment.kind)) {
        throw new ControlPlaneValidationError(
          "Paket tidak tersedia untuk jenis subject ini.",
        );
      }
      const quotaOverride =
        patch.quotaOverride === undefined
          ? enrollment.quotaOverride
          : validQuota(patch.quotaOverride);
      const betaExpiresAt =
        patch.betaExpiresAt === undefined
          ? enrollment.betaExpiresAt
          : optionalFutureIso(patch.betaExpiresAt, at);
      const groupRuntimeMode =
        patch.groupRuntimeMode === undefined
          ? patch.planId !== undefined && planId !== enrollment.planId
            ? runtimeModeForPlan(plan, enrollment.kind)
            : enrollment.groupRuntimeMode
          : validRuntimeMode(patch.groupRuntimeMode, enrollment.kind);

      Object.assign(enrollment, {
        operatorLabel,
        cohort,
        planId,
        quotaOverride,
        betaExpiresAt,
        groupRuntimeMode,
        version: enrollment.version + 1,
        updatedAt: at,
      });
      return structuredClone(enrollment);
    });
  }

  async inviteEvaluation(
    subjectRef: string,
    expectedVersion: number,
  ): Promise<Enrollment> {
    return this.changeConsent(subjectRef, expectedVersion, "invite");
  }

  async revokeEvaluation(
    subjectRef: string,
    expectedVersion: number,
  ): Promise<Enrollment> {
    return this.changeConsent(subjectRef, expectedVersion, "revoke");
  }

  /** Hanya jalur consent peserta yang kelak boleh memanggil metode ini. */
  async recordParticipantEvaluationConsent(
    ownerId: string,
    descriptor: SubjectDescriptor,
    expiresAt: string | null,
  ): Promise<Enrollment> {
    const current = await this.enrollmentForOwner(ownerId, descriptor);
    const at = this.now().toISOString();
    return this.repository.mutate((state) => {
      const enrollment = state.enrollments.find(
        (candidate) => candidate.subjectRef === current.subjectRef,
      );
      if (!enrollment) throw new Error("Enrollment hilang saat consent.");
      enrollment.evaluationConsent = {
        status: "granted",
        invitedAt: enrollment.evaluationConsent.invitedAt,
        grantedAt: at,
        withdrawnAt: null,
        expiresAt: optionalFutureIso(expiresAt, at),
      };
      enrollment.version += 1;
      enrollment.updatedAt = at;
      return structuredClone(enrollment);
    });
  }

  async effectiveLimit(ownerId: string): Promise<number> {
    const enrollment = await this.enrollmentForOwner(ownerId);
    if (enrollment.quotaOverride !== null) return enrollment.quotaOverride;
    const state = await this.repository.snapshot();
    const at = this.now().toISOString();
    const plan = activePlan(state.plans, enrollment.planId, at);
    const base = plan?.rolling24hTokenLimit ?? this.options.fallbackRollingTokenLimit;
    const betaActive =
      enrollment.cohort === "beta" &&
      (enrollment.betaExpiresAt === null || enrollment.betaExpiresAt > at);
    return safeMultiply(base, betaActive ? this.options.betaQuotaMultiplier : 1);
  }

  async effectiveEnrollment(ownerId: string): Promise<{
    enrollment: Enrollment;
    effectiveLimit: number;
    effectiveCohort: Cohort;
  }> {
    const enrollment = await this.enrollmentForOwner(ownerId);
    const at = this.now().toISOString();
    return {
      enrollment,
      effectiveLimit: await this.effectiveLimit(ownerId),
      effectiveCohort:
        enrollment.cohort === "beta" &&
        (enrollment.betaExpiresAt === null || enrollment.betaExpiresAt > at)
          ? "beta"
          : "standard",
    };
  }

  async createPlanVersion(input: NewPlanVersion): Promise<PlanVersion> {
    const normalizedInput = {
      ...input,
      planId: canonicalPlanId(input.planId),
    };
    validatePlanInput(normalizedInput);
    await this.initialize();
    return this.repository.mutate((state) => {
      const matching = state.plans.filter(
        (plan) => plan.planId === normalizedInput.planId,
      );
      closePreviousVersion(
        matching,
        normalizedInput.planId,
        normalizedInput.effectiveFrom,
      );
      const version = nextVersion(state.plans, normalizedInput.planId);
      const created: PlanVersion = {
        ...normalizedInput,
        id: `plan_${shortId()}`,
        version,
        effectiveTo: null,
        createdAt: this.now().toISOString(),
      };
      state.plans.push(created);
      return structuredClone(created);
    });
  }

  async createPriceVersion(input: NewPriceVersion): Promise<ModelPriceVersion> {
    validatePriceInput(input);
    if (!this.configuredModelKeys.has(priceKey(input.providerId, input.modelId))) {
      throw new ControlPlaneValidationError(
        "Model tidak tersedia di konfigurasi environment Harvy.",
      );
    }
    await this.initialize();
    const key = priceKey(input.providerId, input.modelId);
    return this.repository.mutate((state) => {
      const matching = state.prices.filter(
        (price) => priceKey(price.providerId, price.modelId) === key,
      );
      closePreviousVersion(matching, key, input.effectiveFrom);
      const created: ModelPriceVersion = {
        ...input,
        id: `price_${shortId()}`,
        version: Math.max(0, ...matching.map((price) => price.version)) + 1,
        currency: "USD",
        effectiveTo: null,
        createdAt: this.now().toISOString(),
      };
      state.prices.push(created);
      return structuredClone(created);
    });
  }

  async priceAt(
    providerId: string,
    modelId: string,
    at: string,
  ): Promise<ModelPriceVersion | null> {
    await this.initialize();
    const state = await this.repository.snapshot();
    const key = priceKey(providerId, modelId);
    return (
      state.prices
        .filter(
          (price) =>
            priceKey(price.providerId, price.modelId) === key &&
            price.effectiveFrom <= at &&
            (price.effectiveTo === null || price.effectiveTo > at) &&
            price.status !== "retired",
        )
        .sort((left, right) =>
          right.effectiveFrom.localeCompare(left.effectiveFrom, "en"),
        )[0] ?? null
    );
  }

  async resolvePrincipal(
    scopeRef: string,
    rawAliases: readonly string[],
  ): Promise<string | null> {
    const aliases = [...new Set(rawAliases.map((value) => value.trim()))]
      .filter((value) => value.length > 0 && value.length <= 256);
    if (aliases.length === 0) return null;
    await this.initialize();
    return this.repository.mutate((state) => {
      const aliasHashes = aliases.map((alias) =>
        hmac(state.installationKey, `member\u0000${scopeRef}\u0000${alias}`),
      );
      const matched = state.principals.filter(
        (principal) =>
          principal.scopeRef === scopeRef &&
          principal.aliasHashes.some((hash) => aliasHashes.includes(hash)),
      );
      const canonicalCandidates = matched
        .map((principal) => canonicalPrincipal(state.principals, principal))
        .filter((value, index, values) =>
          values.findIndex((candidate) => candidate.principalRef === value.principalRef) === index,
        )
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt, "en"));
      const at = this.now().toISOString();
      let canonical = canonicalCandidates[0];
      if (!canonical) {
        canonical = {
          scopeRef,
          principalRef: `member_${shortId()}`,
          aliasHashes: [],
          mergedInto: null,
          createdAt: at,
          updatedAt: at,
        };
        state.principals.push(canonical);
      }
      canonical.aliasHashes = [
        ...new Set([
          ...canonical.aliasHashes,
          ...aliasHashes,
          ...canonicalCandidates.flatMap((candidate) => candidate.aliasHashes),
        ]),
      ];
      canonical.updatedAt = at;
      for (const duplicate of canonicalCandidates.slice(1)) {
        duplicate.mergedInto = canonical.principalRef;
        duplicate.updatedAt = at;
      }
      return canonical.principalRef;
    });
  }

  async canonicalPrincipalRef(principalRef: string): Promise<string> {
    await this.initialize();
    const state = await this.repository.snapshot();
    const found = state.principals.find(
      (principal) => principal.principalRef === principalRef,
    );
    return found
      ? canonicalPrincipal(state.principals, found).principalRef
      : principalRef;
  }

  /**
   * Mengembalikan seluruh ref historis dalam komponen principal yang cocok,
   * tanpa membuat principal baru. Ini dipakai jalur penghapusan anggota.
   */
  async principalRefsForAliases(
    scopeRef: string,
    rawAliases: readonly string[],
  ): Promise<string[]> {
    const aliases = cleanAliases(rawAliases);
    if (aliases.length === 0) return [];
    await this.initialize();
    const state = await this.repository.snapshot();
    const aliasHashes = aliases.map((alias) =>
      hmac(state.installationKey, `member\u0000${scopeRef}\u0000${alias}`),
    );
    const canonicalMatches = new Set(
      state.principals
        .filter(
          (principal) =>
            principal.scopeRef === scopeRef &&
            principal.aliasHashes.some((hash) => aliasHashes.includes(hash)),
        )
        .map((principal) =>
          canonicalPrincipal(state.principals, principal).principalRef,
        ),
    );
    return state.principals
      .filter(
        (principal) =>
          principal.scopeRef === scopeRef &&
          canonicalMatches.has(
            canonicalPrincipal(state.principals, principal).principalRef,
          ),
      )
      .map((principal) => principal.principalRef);
  }

  async removePrincipalRefs(
    scopeRef: string,
    principalRefs: readonly string[],
  ): Promise<void> {
    const targets = new Set(principalRefs);
    if (targets.size === 0) return;
    await this.initialize();
    await this.repository.mutate((state) => {
      state.principals = state.principals.filter(
        (principal) =>
          principal.scopeRef !== scopeRef || !targets.has(principal.principalRef),
      );
    });
  }

  async audit(
    sessionRef: string,
    action: ConsoleAuditAction,
    targetRef: string | null,
    outcome: ConsoleAuditRecord["outcome"],
    reasonCode: string | null = null,
  ): Promise<void> {
    await this.initialize();
    await this.repository.mutate((state) => {
      state.audit.push({
        id: `audit_${shortId()}`,
        at: this.now().toISOString(),
        sessionRef: cleanRef(sessionRef),
        action,
        targetRef: targetRef ? cleanRef(targetRef) : null,
        outcome,
        reasonCode: reasonCode ? cleanReason(reasonCode) : null,
      });
      if (state.audit.length > MAX_AUDIT_RECORDS) {
        state.audit.splice(0, state.audit.length - MAX_AUDIT_RECORDS);
      }
    });
  }

  async forgetOwner(ownerId: string): Promise<string> {
    const descriptor = describeOwner(ownerId);
    const subjectRef = await this.subjectRef(ownerId, descriptor);
    await this.repository.mutate((state) => {
      state.enrollments = state.enrollments.filter(
        (enrollment) => enrollment.subjectRef !== subjectRef,
      );
      state.principals = state.principals.filter(
        (principal) => principal.scopeRef !== subjectRef,
      );
      for (const record of state.audit) {
        if (record.targetRef === subjectRef) record.targetRef = null;
      }
    });
    return subjectRef;
  }

  private async ensureEnrollment(
    subjectRef: string,
    descriptor: SubjectDescriptor,
    operatorLabel: string | null = null,
  ): Promise<Enrollment> {
    return this.repository.mutate((state) => {
      const existing = state.enrollments.find(
        (candidate) => candidate.subjectRef === subjectRef,
      );
      if (existing) {
        const label = cleanOperatorLabel(operatorLabel);
        if (label !== null && label !== existing.operatorLabel) {
          existing.operatorLabel = label;
          existing.version += 1;
          existing.updatedAt = this.now().toISOString();
        }
        return structuredClone(existing);
      }
      const at = this.now().toISOString();
      const created = defaultEnrollment(subjectRef, descriptor, at, operatorLabel);
      state.enrollments.push(created);
      return structuredClone(created);
    });
  }

  private async changeConsent(
    subjectRef: string,
    expectedVersion: number,
    operation: "invite" | "revoke",
  ): Promise<Enrollment> {
    await this.initialize();
    return this.repository.mutate((state) => {
      const enrollment = state.enrollments.find(
        (candidate) => candidate.subjectRef === subjectRef,
      );
      if (!enrollment) {
        throw new ControlPlaneValidationError("Enrollment tidak ditemukan.");
      }
      if (enrollment.version !== expectedVersion) {
        throw new ControlPlaneConflictError();
      }
      const at = this.now().toISOString();
      enrollment.evaluationConsent = operation === "invite"
        ? {
            status: "invited",
            invitedAt: at,
            grantedAt: null,
            withdrawnAt: null,
            expiresAt: null,
          }
        : {
            status: "withdrawn",
            invitedAt: enrollment.evaluationConsent.invitedAt,
            grantedAt: enrollment.evaluationConsent.grantedAt,
            withdrawnAt: at,
            expiresAt: null,
          };
      enrollment.version += 1;
      enrollment.updatedAt = at;
      return structuredClone(enrollment);
    });
  }

  private async seed(): Promise<void> {
    await this.repository.mutate((state) => {
      const at = this.now().toISOString();
      if (state.plans.length === 0) {
        state.plans.push(...defaultPlans(this.options.fallbackRollingTokenLimit, at));
      }
      migrateLegacyPlanIds(state);
      migrateLegacyPersonalPlanNames(state.plans, at);
      if (state.prices.length === 0) {
        state.prices.push(
          ...bootstrapPrices(this.options.priceBootstraps ?? [], at).filter(
            (price) => this.configuredModelKeys.has(
              priceKey(price.providerId, price.modelId),
            ),
          ),
        );
      }
    });
  }
}

function normalizeConfiguredModels(
  models: readonly ConfiguredModel[],
): ConfiguredModel[] {
  const grouped = new Map<string, ConfiguredModel>();
  for (const model of models) {
    if (!cleanCatalogId(model.providerId) || !cleanCatalogId(model.modelId)) {
      throw new Error("Konfigurasi katalog model tidak sah.");
    }
    const key = priceKey(model.providerId, model.modelId);
    const current = grouped.get(key) ?? {
      providerId: model.providerId,
      modelId: model.modelId,
      active: false,
      sources: [],
    };
    current.active ||= model.active === true;
    current.sources.push(...structuredClone(model.sources));
    grouped.set(key, current);
  }
  return [...grouped.values()].sort((left, right) =>
    priceKey(left.providerId, left.modelId).localeCompare(
      priceKey(right.providerId, right.modelId),
      "en",
    )
  );
}

export function describeOwner(ownerId: string): SubjectDescriptor {
  if (ownerId.startsWith("whatsapp:")) {
    return { kind: "group", channel: "whatsapp" };
  }
  if (ownerId.startsWith("telegram:")) {
    return { kind: "group", channel: "telegram" };
  }
  return { kind: "private", channel: "telegram" };
}

function defaultEnrollment(
  subjectRef: string,
  descriptor: SubjectDescriptor,
  at: string,
  operatorLabel: string | null = null,
): Enrollment {
  const consent: EvaluationConsent = {
    status: "not_invited",
    invitedAt: null,
    grantedAt: null,
    withdrawnAt: null,
    expiresAt: null,
  };
  return {
    subjectRef,
    operatorLabel: cleanOperatorLabel(operatorLabel),
    kind: descriptor.kind,
    channel: descriptor.channel,
    cohort: "standard",
    planId: descriptor.kind === "group" ? "group_direct" : PERSONAL_PLAN_IDS.free,
    quotaOverride: null,
    betaExpiresAt: null,
    groupRuntimeMode: descriptor.kind === "group" ? "direct_only" : null,
    evaluationConsent: consent,
    version: 1,
    createdAt: at,
    updatedAt: at,
  };
}

function cleanOperatorLabel(value: string | null): string | null {
  if (value === null) return null;
  const clean = value.trim();
  if (clean.length === 0) return null;
  if (clean.length > 64 || /[\u0000-\u001f]/u.test(clean)) {
    throw new ControlPlaneValidationError("Label pseudonim operator tidak sah.");
  }
  return clean;
}

function defaultPlans(base: number, at: string): PlanVersion[] {
  const specs: Omit<PlanVersion, "id" | "version" | "effectiveFrom" | "effectiveTo" | "createdAt">[] = [
    ...PERSONAL_PLAN_SPECS.map((spec) => ({
      planId: spec.planId,
      publicName: spec.publicName,
      audience: "personal" as const,
      monthlyPriceIdr: spec.monthlyPriceIdr,
      rolling24hTokenLimit: safeMultiply(base, spec.capacityMultiplier),
      activeMemberLimit: null,
      groupMode: "none" as const,
      status: "pilot" as const,
    })),
    { planId: "group_direct", publicName: "Sapa", audience: "group", monthlyPriceIdr: 99_000, rolling24hTokenLimit: safeMultiply(base, 5), activeMemberLimit: 50, groupMode: "direct_only", status: "pilot" },
    { planId: "group_ambient", publicName: "Nimbrung", audience: "group", monthlyPriceIdr: 249_000, rolling24hTokenLimit: safeMultiply(base, 15), activeMemberLimit: 50, groupMode: "ambient", status: "pilot" },
    { planId: "workspace", publicName: "Ruang", audience: "workspace", monthlyPriceIdr: 599_000, rolling24hTokenLimit: safeMultiply(base, 30), activeMemberLimit: 150, groupMode: "workspace", status: "pilot" },
  ];
  return specs.map((spec) => ({
    ...spec,
    id: `plan_${shortId()}`,
    version: 1,
    effectiveFrom: at,
    effectiveTo: null,
    createdAt: at,
  }));
}

function migrateLegacyPersonalPlanNames(
  plans: PlanVersion[],
  at: string,
): void {
  for (const spec of PERSONAL_PLAN_SPECS) {
    const matching = plans.filter((plan) => plan.planId === spec.planId);
    const current = activePlan(plans, spec.planId, at);
    if (!current || current.publicName !== spec.legacyPublicName) continue;

    const latest = [...matching].sort((left, right) =>
      right.effectiveFrom.localeCompare(left.effectiveFrom, "en") ||
      right.version - left.version
    )[0];
    // Jangan menimpa versi operator yang sudah dijadwalkan atau memalsukan
    // urutan waktu bila jam host bergerak mundur. Startup berikutnya akan
    // mencoba migrasi lagi setelah versi aktif menjadi versi terbaru.
    if (!latest || latest.id !== current.id || latest.effectiveFrom >= at) {
      continue;
    }

    current.effectiveTo = at;
    plans.push({
      ...current,
      id: `plan_${shortId()}`,
      version: nextVersion(plans, spec.planId),
      publicName: spec.publicName,
      effectiveFrom: at,
      effectiveTo: null,
      createdAt: at,
    });
  }
}

function migrateLegacyPlanIds(state: ControlPlaneState): void {
  for (const plan of state.plans) {
    plan.planId = canonicalPlanId(plan.planId);
  }
  for (const enrollment of state.enrollments) {
    enrollment.planId = canonicalPlanId(enrollment.planId);
  }
  for (const audit of state.audit) {
    if (audit.targetRef !== null) {
      audit.targetRef = canonicalPlanId(audit.targetRef);
    }
  }
}

function bootstrapPrices(
  bootstraps: readonly PriceBootstrap[],
  at: string,
): ModelPriceVersion[] {
  const grouped = new Map<string, PriceBootstrap[]>();
  for (const bootstrap of bootstraps) {
    if (
      !cleanCatalogId(bootstrap.providerId) ||
      !cleanCatalogId(bootstrap.modelId) ||
      !validUsdRate(bootstrap.inputPerMillionUsd) ||
      !validUsdRate(bootstrap.outputPerMillionUsd)
    ) {
      continue;
    }
    // Nilai 0/0 dari konfigurasi lama berarti "pantau token saja", bukan bukti
    // bahwa model gratis. Harga nol sungguhan tetap dapat dibuat eksplisit lewat
    // createPriceVersion di Console.
    if (
      usdDecimalToNanos(bootstrap.inputPerMillionUsd) === 0n &&
      usdDecimalToNanos(bootstrap.outputPerMillionUsd) === 0n
    ) {
      continue;
    }
    const key = priceKey(bootstrap.providerId, bootstrap.modelId);
    grouped.set(key, [...(grouped.get(key) ?? []), bootstrap]);
  }
  return [...grouped.values()].flatMap((items) => {
    const rates = new Set(
      items.map((item) => `${item.inputPerMillionUsd}\u0000${item.outputPerMillionUsd}`),
    );
    if (rates.size !== 1) return [];
    const item = items[0];
    if (!item) return [];
    return [{
      id: `price_${shortId()}`,
      providerId: item.providerId,
      modelId: item.modelId,
      version: 1,
      currency: "USD" as const,
      rates: {
        inputPerMillionUsd: item.inputPerMillionUsd,
        outputPerMillionUsd: item.outputPerMillionUsd,
        cacheReadPerMillionUsd: null,
        cacheWritePerMillionUsd: null,
        reasoningPerMillionUsd: null,
        perRequestUsd: null,
      },
      effectiveFrom: at,
      effectiveTo: null,
      status: "pilot" as const,
      createdAt: at,
    }];
  });
}

function cleanAliases(rawAliases: readonly string[]): string[] {
  return [...new Set(rawAliases.map((value) => value.trim()))]
    .filter((value) => value.length > 0 && value.length <= 256);
}

function subjectRefOf(
  key: string,
  ownerId: string,
  descriptor: SubjectDescriptor,
): string {
  return `subject_${hmac(
    key,
    `subject\u0000${descriptor.kind}\u0000${descriptor.channel}\u0000${ownerId}`,
  ).slice(0, 32)}`;
}

function hmac(key: string, value: string): string {
  return createHmac("sha256", key).update(value, "utf8").digest("base64url");
}

function canonicalPrincipal(
  principals: readonly ScopedPrincipal[],
  principal: ScopedPrincipal,
): ScopedPrincipal {
  let current = principal;
  const seen = new Set<string>();
  while (current.mergedInto && !seen.has(current.principalRef)) {
    seen.add(current.principalRef);
    const next = principals.find(
      (candidate) => candidate.principalRef === current.mergedInto,
    );
    if (!next) break;
    current = next;
  }
  return current;
}

function activePlan(
  plans: readonly PlanVersion[],
  planId: string,
  at: string,
): PlanVersion | null {
  return plans
    .filter(
      (plan) =>
        plan.planId === planId &&
        plan.effectiveFrom <= at &&
        (plan.effectiveTo === null || plan.effectiveTo > at) &&
        plan.status !== "retired",
    )
    .sort((left, right) => right.version - left.version)[0] ?? null;
}

function planMatchesSubject(plan: PlanVersion, kind: SubjectKind): boolean {
  return kind === "private"
    ? plan.audience === "personal"
    : plan.audience === "group" || plan.audience === "workspace";
}

function runtimeModeForPlan(
  plan: PlanVersion,
  kind: SubjectKind,
): GroupRuntimeMode | null {
  if (kind === "private") return null;
  if (plan.groupMode === "ambient" || plan.groupMode === "workspace") {
    return "ambient";
  }
  return "direct_only";
}

function validQuota(value: number | null): number | null {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ControlPlaneValidationError("Override kuota tidak sah.");
  }
  return value;
}

function validRuntimeMode(
  value: GroupRuntimeMode | null,
  kind: SubjectKind,
): GroupRuntimeMode | null {
  if (kind === "private") {
    if (value !== null) {
      throw new ControlPlaneValidationError("Mode grup tidak berlaku untuk chat privat.");
    }
    return null;
  }
  if (
    value !== null &&
    !(["direct_only", "ambient", "paused", "disabled"] as const).includes(value)
  ) {
    throw new ControlPlaneValidationError("Mode grup tidak sah.");
  }
  return value;
}

function optionalFutureIso(value: string | null, now: string): string | null {
  if (value === null) return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value || value <= now) {
    throw new ControlPlaneValidationError("Waktu kedaluwarsa tidak sah.");
  }
  return value;
}

function validatePlanInput(input: NewPlanVersion): void {
  const shapeValid =
    (input.audience === "personal" &&
      input.groupMode === "none" &&
      input.activeMemberLimit === null) ||
    (input.audience === "group" &&
      (input.groupMode === "direct_only" || input.groupMode === "ambient")) ||
    (input.audience === "workspace" && input.groupMode === "workspace");
  if (
    !cleanCatalogId(input.planId) ||
    !cleanPublicName(input.publicName) ||
    !Number.isSafeInteger(input.monthlyPriceIdr) ||
    input.monthlyPriceIdr < 0 ||
    !Number.isSafeInteger(input.rolling24hTokenLimit) ||
    input.rolling24hTokenLimit < 0 ||
    (input.activeMemberLimit !== null &&
      (!Number.isSafeInteger(input.activeMemberLimit) || input.activeMemberLimit < 1)) ||
    !isIso(input.effectiveFrom) ||
    !shapeValid
  ) {
    throw new ControlPlaneValidationError("Versi paket tidak sah.");
  }
}

function validatePriceInput(input: NewPriceVersion): void {
  if (
    !cleanCatalogId(input.providerId) ||
    !cleanCatalogId(input.modelId) ||
    !Object.values(input.rates).every((rate) => rate === null || validUsdRate(rate)) ||
    !validUsdRate(input.rates.inputPerMillionUsd) ||
    !validUsdRate(input.rates.outputPerMillionUsd) ||
    !isIso(input.effectiveFrom)
  ) {
    throw new ControlPlaneValidationError("Versi harga tidak sah.");
  }
}

function closePreviousVersion<T extends { effectiveFrom: string; effectiveTo: string | null }>(
  versions: T[],
  _key: string,
  effectiveFrom: string,
): void {
  if (!isIso(effectiveFrom)) {
    throw new ControlPlaneValidationError("Waktu efektif tidak sah.");
  }
  const latest = [...versions]
    .sort((left, right) => right.effectiveFrom.localeCompare(left.effectiveFrom, "en"))[0];
  if (latest && latest.effectiveFrom >= effectiveFrom) {
    throw new ControlPlaneValidationError("Versi baru harus berlaku setelah versi sebelumnya.");
  }
  if (latest?.effectiveTo === null) latest.effectiveTo = effectiveFrom;
}

function nextVersion(
  plans: readonly PlanVersion[],
  planId: string,
): number {
  return Math.max(0, ...plans.filter((plan) => plan.planId === planId).map((plan) => plan.version)) + 1;
}

function priceKey(providerId: string, modelId: string): string {
  return `${providerId}\u0000${modelId}`;
}

function cleanCatalogId(value: string): boolean {
  return value.length >= 1 && value.length <= 160 && !/[\u0000-\u001f<>]/u.test(value);
}

function cleanPublicName(value: string): boolean {
  return value.trim().length >= 1 && value.trim().length <= 40 && !/[\u0000-\u001f<>]/u.test(value);
}

function isIso(value: string): boolean {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function cleanRef(value: string): string {
  const clean = value.replace(/[^a-zA-Z0-9_-]/gu, "").slice(0, 96);
  return clean || "unknown";
}

function cleanReason(value: string): string {
  const clean = value.replace(/[^a-z0-9_-]/gu, "").slice(0, 64);
  return clean || "unknown";
}

function safeMultiply(value: number, multiplier: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, value * multiplier);
}

function shortId(): string {
  return randomUUID().replaceAll("-", "").slice(0, 16);
}

function sortByNewest<T extends { effectiveFrom: string }>(items: readonly T[]): T[] {
  return [...items].sort((left, right) =>
    right.effectiveFrom.localeCompare(left.effectiveFrom, "en"),
  );
}
