import { createHash, randomUUID } from "node:crypto";
import type { AgentRunInput, AgentRunResult } from "../harness/agent-harness.js";
import type { AgentScope } from "../harness/scope.js";
import type { ConversationEpisode } from "../domain/history.js";
import type { MemoryItem, NewMemory } from "../domain/memory.js";
import type {
  DurableEpisodeArchive,
  ErrorLesson,
  FailureSignature,
  LearningCandidate,
  LearningEvent,
  LearningEventKind,
  LearningEventPayload,
  LearningEvidenceReference,
  LearningPromotionPolicy,
  LongTermMemoryRetriever,
  LongTermMemorySnapshot,
  ProcedureDraft,
  ProcedureMemory,
  UserModelFact,
} from "../domain/long-term-memory.js";
import type {
  MemoryKnowledgeNamespace,
  RetrievedMemoryEvidence,
} from "../domain/memory-knowledge.js";
import {
  memoryNamespaceKey,
  privateMemoryNamespace,
  validateMemoryNamespace,
} from "./memory-namespace.js";
import {
  NOOP_OPERATIONAL_LOGGER,
  type OperationalLogger,
} from "../observability/operational-logger.js";
import { containsSecretLikeValue } from "../security/credential-like.js";
import {
  SqliteLongTermMemoryRepository,
  type LearningCommit,
} from "../storage/sqlite-long-term-memory-repository.js";

const DEFAULT_PROMOTION_POLICY: LearningPromotionPolicy = Object.freeze({
  procedureSuccesses: 2,
  procedureVerifiedSuccesses: 2,
  procedureFailuresToDegrade: 2,
  recentOutcomeWindow: 8,
});
const MAX_EVENT_PAYLOAD_CHARACTERS = 32_000;
const MAX_EVIDENCE_PER_RECORD = 32;
const MAX_PROCEDURE_STEPS = 32;

export type LearningCandidateExtractor = (
  event: LearningEvent,
) => Promise<LearningEventPayload>;

/**
 * Event-driven long-term learning coordinator.
 *
 * Enqueue is a small durable local transaction. Candidate extraction and
 * promotion run after it on a bounded worker, never from the simple retrieval
 * fast path. Generation is checked again in the repository transaction so a
 * late extractor cannot recreate data after forget/delete.
 */
export class LongTermMemoryService
implements DurableEpisodeArchive, LongTermMemoryRetriever {
  private readonly blocked = new Set<string>();
  private worker: Promise<void> | null = null;
  private accepting = true;

  constructor(
    private readonly repository: SqliteLongTermMemoryRepository,
    private readonly now: () => Date = () => new Date(),
    private readonly makeId: () => string = randomUUID,
    private readonly policy: LearningPromotionPolicy = DEFAULT_PROMOTION_POLICY,
    private readonly extractor: LearningCandidateExtractor = async (event) =>
      event.payload,
    private readonly logger: OperationalLogger =
      NOOP_OPERATIONAL_LOGGER.child("core.long-term-memory"),
  ) {
    validatePromotionPolicy(policy);
  }

  async archive(
    namespaceInput: MemoryKnowledgeNamespace,
    episode: ConversationEpisode,
  ): Promise<void> {
    const namespace = validateMemoryNamespace(namespaceInput);
    if (this.isBlocked(namespace)) return;
    const text = JSON.stringify(episode);
    if (containsSecretLikeValue(text)) {
      throw new Error("Episode memuat pola credential dan tidak boleh diarsipkan.");
    }
    const stored = await this.repository.archiveEpisode(namespace, episode, this.now());
    if (!stored && !this.isBlocked(namespace)) {
      throw new Error("Archive episode ditolak oleh generation fence.");
    }
  }

  async search(
    namespaceInput: MemoryKnowledgeNamespace,
    query: string,
    options: { limit?: number } = {},
  ) {
    const namespace = validateMemoryNamespace(namespaceInput);
    if (this.isBlocked(namespace)) return [];
    const startedAt = Date.now();
    const result = await this.repository.searchArchive(
      namespace,
      query,
      options.limit,
    );
    this.logger.debug(
      "archive_search_completed",
      "Pencarian archive long-term selesai.",
      { resultCount: result.length, durationMs: Date.now() - startedAt },
    );
    return this.isBlocked(namespace) ? [] : result;
  }

  async list(namespaceInput: MemoryKnowledgeNamespace): Promise<ConversationEpisode[]> {
    const namespace = validateMemoryNamespace(namespaceInput);
    return this.isBlocked(namespace) ? [] : this.repository.listArchive(namespace);
  }

  async remove(namespaceInput: MemoryKnowledgeNamespace): Promise<boolean> {
    return this.repository.removeArchive(validateMemoryNamespace(namespaceInput));
  }

  suspend(namespaceInput: MemoryKnowledgeNamespace): void {
    const namespace = validateMemoryNamespace(namespaceInput);
    this.blocked.add(memoryNamespaceKey(namespace));
    try {
      this.repository.suspend(namespace, this.now().toISOString());
    } catch (error) {
      this.logger.error(
        "long_term_memory_suspend_failed",
        "Scope long-term memory ditutup lokal tetapi persistence suspension gagal.",
        error,
      );
    }
  }

  allow(namespaceInput: MemoryKnowledgeNamespace): void {
    const namespace = validateMemoryNamespace(namespaceInput);
    this.blocked.delete(memoryNamespaceKey(namespace));
    void this.repository.allow(namespace, this.now().toISOString());
  }

  async enqueue(
    namespaceInput: MemoryKnowledgeNamespace,
    kind: LearningEventKind,
    payload: LearningEventPayload,
    idempotencySeed?: string,
  ): Promise<"enqueued" | "deduped" | "blocked" | "ineligible"> {
    const namespace = validateMemoryNamespace(namespaceInput);
    if (!this.accepting || this.isBlocked(namespace)) return "blocked";
    const clean = validatePayload(payload);
    if (!clean) return "ineligible";
    const serialized = JSON.stringify(clean);
    if (
      serialized.length > MAX_EVENT_PAYLOAD_CHARACTERS ||
      containsSecretLikeValue(serialized)
    ) {
      return "ineligible";
    }
    const state = await this.repository.currentGeneration(namespace);
    if (state.blocked || this.isBlocked(namespace)) return "blocked";
    const occurredAt = this.now().toISOString();
    const idempotencyKey = sha256([
      memoryNamespaceKey(namespace),
      kind,
      idempotencySeed ?? canonicalPayload(clean),
    ].join("\0"));
    const event: LearningEvent = {
      eventId: `le-${cleanId(this.makeId())}`,
      idempotencyKey,
      namespace,
      generation: state.generation,
      kind,
      occurredAt,
      createdAt: occurredAt,
      status: "pending",
      attempts: 0,
      payload: clean,
    };
    const result = await this.repository.enqueue(event);
    this.logger.debug(
      result === "deduped" ? "learning_event_deduped" : "learning_event_enqueued",
      "Learning event dipersistenkan tanpa memuat content ke log.",
      { kind, result },
    );
    if (result === "enqueued") this.kick();
    return result;
  }

  /** Runtime hook for user-visible primary memory that already passed policy. */
  async rememberSource(item: MemoryItem, input: NewMemory): Promise<void> {
    const category = categoryForMemory(item.kind);
    if (!category) return;
    const provenance = input.provenance ?? "asserted";
    const evidence = memoryEvidence(item, input);
    await this.enqueue(
      privateMemoryNamespace(item.ownerId),
      item.kind === "preference"
        ? "durable_preference_discovered"
        : "explicit_remember_request",
      {
        userFact: {
          category,
          subject: input.subject ?? "user",
          predicate: input.predicate ?? item.kind,
          value: input.value ?? item.content,
          displayText: item.content,
          provenance,
          confidence: boundedConfidence(input.confidence ?? 1, provenance),
          stability: item.kind === "context" ? "evolving" : "stable",
          lastConfirmedAt: provenance === "asserted" ? item.createdAt : null,
          validFrom: input.validFrom ?? item.createdAt,
          validUntil: input.validUntil ?? item.expiresAt,
          evidence: [evidence],
          sourceMemoryIds: [item.id],
        },
        sourceMemoryIds: [item.id],
        sourceEpisodeIds: input.sourceEpisodeIds ?? [],
        evidence: [evidence],
      },
      `memory:${item.id}:${sha256(item.content)}`,
    );
  }

  async editSource(
    previous: MemoryItem,
    updated: MemoryItem,
    input?: NewMemory,
  ): Promise<void> {
    const category = categoryForMemory(updated.kind);
    if (!category) return;
    const evidence = memoryEvidence(updated, input);
    await this.enqueue(
      privateMemoryNamespace(updated.ownerId),
      "user_correction",
      {
        userFact: {
          category,
          subject: input?.subject ?? "user",
          predicate: input?.predicate ?? updated.kind,
          value: input?.value ?? updated.content,
          displayText: updated.content,
          provenance: "asserted",
          confidence: 1,
          stability: updated.kind === "context" ? "evolving" : "stable",
          lastConfirmedAt: this.now().toISOString(),
          validFrom: this.now().toISOString(),
          validUntil: input?.validUntil ?? updated.expiresAt,
          evidence: [evidence],
          sourceMemoryIds: [updated.id],
        },
        sourceMemoryIds: [updated.id],
        evidence: [evidence],
      },
      `memory-edit:${previous.id}:${sha256(previous.content)}:${sha256(updated.content)}`,
    );
  }

  async forgetSource(item: MemoryItem): Promise<void> {
    await this.repository.removeSource(privateMemoryNamespace(item.ownerId), item.id);
  }

  async forgetPrivateOwner(ownerId: string): Promise<void> {
    await this.forgetAll(privateMemoryNamespace(ownerId));
  }

  suspendPrivateOwner(ownerId: string): void {
    this.suspend(privateMemoryNamespace(ownerId));
  }

  allowPrivateOwner(ownerId: string): void {
    this.allow(privateMemoryNamespace(ownerId));
  }

  async forgetAll(namespaceInput: MemoryKnowledgeNamespace): Promise<void> {
    const namespace = validateMemoryNamespace(namespaceInput);
    this.suspend(namespace);
    await this.repository.blockAndForget(namespace, this.now().toISOString());
  }

  /** Agent runs create evidence-backed candidates; no model/reflection is called. */
  async observeAgentRun(
    input: Pick<AgentRunInput, "scope" | "request">,
    result: AgentRunResult,
  ): Promise<void> {
    const namespace = learningNamespaceForAgentScope(input.scope);
    if (!namespace) return;
    const observations = result.checkpoint.observations;
    if (observations.length === 0) return;
    const procedure = procedureDraftFromRun(input.request, observations);
    if (!procedure) return;
    const completed = result.status === "completed";
    const failure = observations.find((observation) => observation.status === "error");
    const eventKind: LearningEventKind = completed
      ? "procedure_success"
      : "procedure_failure";
    const sourceRunId = result.checkpoint.runId;
    const evidence = observations.slice(0, MAX_EVIDENCE_PER_RECORD).map(
      (observation): LearningEvidenceReference => ({
        kind: "tool_result",
        sourceId: `${sourceRunId}:${observation.step}:${observation.capabilityId}`,
        contentHash: sha256([
          observation.capabilityId,
          observation.status,
          observation.summary,
        ].join("\0")),
        occurredAt: this.now().toISOString(),
        sourceEpisodeId: null,
        sourceSequences: [],
        locator: null,
      }),
    );
    await this.enqueue(namespace, eventKind, {
      procedure,
      outcome: {
        technical: completed ? "success" : "failure",
        task: completed ? "success" : "unknown",
        user: "unknown",
        verified: completed && observations.every((item) => item.status === "ok"),
      },
      sourceRunId,
      evidence,
      ...(failure
        ? {
            failure: normalizeFailureSignature({
              tool: failure.capabilityId,
              operation: procedure.logicalKey,
              message: failure.summary,
              exceptionType: "AgentCapabilityError",
              environment: input.scope.kind,
            }),
          }
        : {}),
    }, `agent-run:${sourceRunId}:${eventKind}`);
  }

  async searchUserModel(
    namespaceInput: MemoryKnowledgeNamespace,
    query: string,
    limit: number,
  ): Promise<RetrievedMemoryEvidence[]> {
    const namespace = validateMemoryNamespace(namespaceInput);
    if (this.isBlocked(namespace)) return [];
    const facts = await this.repository.searchUserFacts(namespace, query, limit);
    return facts.map((fact, index) => ({ fact, index, confidence: effectiveFactConfidence(
      fact,
      this.now(),
    ) }))
      .filter(({ confidence }) => confidence >= 0.15)
      .map(({ fact, index, confidence }) => ({
      id: `user-model:${fact.id}`,
      sources: ["user-model"],
      text: fact.displayText,
      score: roundScore(
        confidence * authorityWeight(fact.provenance) + 1 / (index + 2),
      ),
      validFrom: fact.validFrom,
      validUntil: fact.validUntil,
      status: fact.status,
      sensitivity: "normal",
      sourceEpisodeIds: unique(fact.evidence.flatMap((item) =>
        item.sourceEpisodeId ? [item.sourceEpisodeId] : [])),
      sourceSequences: uniqueNumbers(
        fact.evidence.flatMap((item) => item.sourceSequences),
      ),
      sourceMemoryIds: [...fact.sourceMemoryIds],
      }));
  }

  async searchProcedures(
    namespaceInput: MemoryKnowledgeNamespace,
    query: string,
    options: { limit: number; environment?: readonly string[] },
  ): Promise<RetrievedMemoryEvidence[]> {
    const namespace = validateMemoryNamespace(namespaceInput);
    if (this.isBlocked(namespace)) return [];
    const records = await this.repository.searchProcedureRecords(
      namespace,
      query,
      options.limit,
    );
    const environment = new Set((options.environment ?? []).map(normalize));
    return records
      .map((procedure) => ({
        procedure,
        environmentScore: procedure.environmentConstraints.length === 0
          ? 0.5
          : procedure.environmentConstraints.some((item) =>
              environment.has(normalize(item)))
          ? 1
          : environment.size > 0 ? 0 : 0.25,
      }))
      .filter(({ procedure, environmentScore }) =>
        procedure.status !== "quarantined" &&
        procedure.status !== "retired" &&
        environmentScore > 0)
      .sort((left, right) =>
        procedureRank(right.procedure, right.environmentScore) -
          procedureRank(left.procedure, left.environmentScore))
      .slice(0, Math.max(0, options.limit))
      .map(({ procedure, environmentScore }) => ({
        id: `procedure:${procedure.procedureId}`,
        sources: ["procedure"],
        text: renderProcedure(procedure),
        score: roundScore(procedureRank(procedure, environmentScore)),
        validFrom: procedure.createdAt,
        validUntil: null,
        status: procedure.status === "active" ? "active" : "uncertain",
        sensitivity: "normal",
        sourceEpisodeIds: [...procedure.sourceEpisodeIds],
        sourceSequences: uniqueNumbers(
          procedure.evidence.flatMap((item) => item.sourceSequences),
        ),
        sourceMemoryIds: [],
      }));
  }

  async searchErrorLessons(
    namespaceInput: MemoryKnowledgeNamespace,
    query: string,
    limit: number,
  ): Promise<RetrievedMemoryEvidence[]> {
    const namespace = validateMemoryNamespace(namespaceInput);
    if (this.isBlocked(namespace)) return [];
    const lessons = await this.repository.searchErrorLessonRecords(
      namespace,
      query,
      limit,
    );
    return lessons.map((lesson) => ({
      id: `error-lesson:${lesson.lessonId}`,
      sources: ["error-lesson"],
      text: renderErrorLesson(lesson),
      score: roundScore(lesson.confidence + Math.min(lesson.successCount, 5) * 0.1),
      validFrom: lesson.firstSeenAt,
      validUntil: null,
      status: lesson.status === "active" ? "active" : "uncertain",
      sensitivity: "normal",
      sourceEpisodeIds: unique(lesson.evidence.flatMap((item) =>
        item.sourceEpisodeId ? [item.sourceEpisodeId] : [])),
      sourceSequences: uniqueNumbers(
        lesson.evidence.flatMap((item) => item.sourceSequences),
      ),
      sourceMemoryIds: [],
    }));
  }

  /** Exact normalized lookup precedes any fuzzy/semantic fallback. */
  async findErrorLesson(
    namespaceInput: MemoryKnowledgeNamespace,
    signature: FailureSignature,
  ): Promise<ErrorLesson | null> {
    const namespace = validateMemoryNamespace(namespaceInput);
    if (this.isBlocked(namespace)) return null;
    return this.repository.loadErrorLesson(namespace, signature.fingerprint);
  }

  async snapshotPrivateOwner(ownerId: string): Promise<LongTermMemorySnapshot> {
    return this.repository.snapshot(privateMemoryNamespace(ownerId));
  }

  async recover(): Promise<void> {
    this.kick();
    await this.drain();
  }

  async drain(): Promise<void> {
    while (this.worker) await this.worker;
  }

  stop(): void {
    this.accepting = false;
  }

  close(): void {
    this.repository.close();
  }

  private kick(): void {
    if (this.worker) return;
    const running = this.runWorker().finally(() => {
      if (this.worker === running) this.worker = null;
    });
    this.worker = running;
  }

  private async runWorker(): Promise<void> {
    while (true) {
      const event = await this.repository.claimNext();
      if (!event) return;
      try {
        const payload = validatePayload(await this.extractor(event));
        const commit = payload
          ? await this.promote({ ...event, payload })
          : {};
        const result = await this.repository.commitLearning(event, commit);
        this.logger.debug(
          "learning_event_processed",
          "Learning event selesai tanpa content di log.",
          { kind: event.kind, result },
        );
        if (result === "committed" && event.payload.procedure) {
          const procedure = commit.procedures?.find((item) =>
            item.status !== "superseded"
          );
          this.logger.debug(
            "procedure_outcome",
            "Outcome procedure dipersistenkan tanpa nama, langkah, atau evidence.",
            {
              eventKind: event.kind,
              status: procedure?.status ?? "unchanged",
              verified: event.payload.outcome?.verified ?? false,
              technicalOutcome: event.payload.outcome?.technical ?? "unknown",
              taskOutcome: event.payload.outcome?.task ?? "unknown",
              userOutcome: event.payload.outcome?.user ?? "unknown",
            },
          );
        }
      } catch (error) {
        await this.repository.requeue(event);
        this.logger.error(
          "learning_event_processing_failed",
          "Learning event ditahan durable untuk retry berikutnya.",
          error,
          { kind: event.kind, attempts: event.attempts },
        );
        return;
      }
    }
  }

  private async promote(event: LearningEvent): Promise<LearningCommit> {
    if (event.payload.userFact) return this.promoteUserFact(event);
    if (event.payload.procedure) return this.promoteProcedure(event);
    if (event.payload.failure) return this.promoteErrorLesson(event);
    return {};
  }

  private async promoteUserFact(event: LearningEvent): Promise<LearningCommit> {
    const input = event.payload.userFact!;
    const slot = await this.repository.loadUserFactSlot(
      event.namespace,
      input.subject,
      input.predicate,
    );
    const current = slot.filter((fact) =>
      fact.status === "active" || fact.status === "uncertain");
    const same = current.find((fact) => normalize(fact.value) === normalize(input.value));
    const evidence = mergeEvidence(
      same?.evidence ?? [],
      input.evidence,
    );
    const sourceMemoryIds = unique([
      ...(same?.sourceMemoryIds ?? []),
      ...input.sourceMemoryIds,
    ]);
    const correction = event.kind === "user_correction";
    const facts: UserModelFact[] = [];
    let fact: UserModelFact;
    if (same && !correction) {
      fact = {
        ...same,
        confidence: Math.max(same.confidence, input.confidence),
        lastObservedAt: event.occurredAt,
        lastConfirmedAt: input.lastConfirmedAt ?? same.lastConfirmedAt,
        evidence,
        sourceMemoryIds,
      };
    } else {
      if (correction) {
        facts.push(...current.map((existing) => ({
          ...existing,
          status: "superseded" as const,
          validUntil: event.occurredAt,
          lastObservedAt: event.occurredAt,
        })));
      } else if (current.length > 0) {
        facts.push(...current.map((existing) => ({
          ...existing,
          status: "uncertain" as const,
          lastObservedAt: event.occurredAt,
        })));
      }
      fact = {
        id: `um-${cleanId(this.makeId())}`,
        namespace: event.namespace,
        ...input,
        confidence: boundedConfidence(input.confidence, input.provenance),
        status: correction || current.length === 0 ? "active" : "uncertain",
        learnedAt: event.occurredAt,
        lastObservedAt: event.occurredAt,
        supersedesId: correction ? current.at(-1)?.id ?? null : null,
        evidence,
        sourceMemoryIds,
      };
    }
    facts.push(fact);
    const fingerprint = sha256([
      normalize(input.subject),
      normalize(input.predicate),
      normalize(input.value),
    ].join("\0"));
    return {
      candidate: candidateFor(
        event,
        "user_model",
        fingerprint,
        fact.status === "active" ? "promoted" : "candidate",
        fact.confidence,
        this.makeId,
      ),
      userFacts: facts,
    };
  }

  private async promoteProcedure(event: LearningEvent): Promise<LearningCommit> {
    const draft = event.payload.procedure!;
    const existing = await this.repository.loadCurrentProcedure(
      event.namespace,
      draft.logicalKey,
    );
    const outcome = event.payload.outcome ?? {
      technical: "unknown",
      task: "unknown",
      user: "unknown",
      verified: false,
    };
    const success = outcome.technical === "success" &&
      outcome.task !== "failure" && outcome.user !== "rejected";
    const failure = outcome.technical === "failure" ||
      outcome.task === "failure" || outcome.user === "rejected";
    const sameDefinition = existing ? procedureDefinitionHash(existing) ===
      procedureDefinitionHash(draft) : false;
    const procedures: ProcedureMemory[] = [];
    let procedure: ProcedureMemory;

    if (existing && sameDefinition) {
      const recentOutcomes = [
        ...existing.recentOutcomes,
        ...(success ? ["success" as const] : failure ? ["failure" as const] : []),
      ].slice(-this.policy.recentOutcomeWindow);
      const successCount = existing.successCount + (success ? 1 : 0);
      const verifiedSuccessCount = existing.verifiedSuccessCount +
        (success && outcome.verified ? 1 : 0);
      const failureCount = existing.failureCount + (failure ? 1 : 0);
      const recentFailures = recentOutcomes.slice(
        -this.policy.procedureFailuresToDegrade,
      ).filter((item) => item === "failure").length;
      let status = existing.status;
      if (
        successCount >= this.policy.procedureSuccesses &&
        verifiedSuccessCount >= this.policy.procedureVerifiedSuccesses &&
        status !== "quarantined"
      ) status = "active";
      if (
        failure && existing.status === "active" &&
        recentFailures >= this.policy.procedureFailuresToDegrade
      ) status = "degraded";
      if (outcome.user === "rejected") status = "quarantined";
      procedure = {
        ...existing,
        ...draft,
        status,
        updatedAt: event.occurredAt,
        lastUsedAt: event.occurredAt,
        lastSuccessAt: success ? event.occurredAt : existing.lastSuccessAt,
        lastFailureAt: failure ? event.occurredAt : existing.lastFailureAt,
        successCount,
        verifiedSuccessCount,
        failureCount,
        recentOutcomes,
        confidence: procedureConfidence(successCount, failureCount, outcome.verified),
        sourceEpisodeIds: unique([
          ...existing.sourceEpisodeIds,
          ...(event.payload.sourceEpisodeIds ?? []),
        ]),
        sourceRunIds: unique([
          ...existing.sourceRunIds,
          ...(event.payload.sourceRunId ? [event.payload.sourceRunId] : []),
        ]),
        sourceMemoryIds: unique([
          ...(existing.sourceMemoryIds ?? []),
          ...(event.payload.sourceMemoryIds ?? []),
        ]),
        sourceEventIds: unique([...existing.sourceEventIds, event.eventId]),
        evidence: mergeEvidence(existing.evidence, event.payload.evidence ?? []),
      };
    } else {
      if (existing && existing.status !== "superseded") {
        procedures.push({
          ...existing,
          status: "superseded",
          updatedAt: event.occurredAt,
        });
      }
      const successCount = success ? 1 : 0;
      const verifiedSuccessCount = success && outcome.verified ? 1 : 0;
      const failureCount = failure ? 1 : 0;
      procedure = {
        procedureId: `proc-${cleanId(this.makeId())}`,
        namespace: event.namespace,
        ...draft,
        version: (existing?.version ?? 0) + 1,
        confidence: procedureConfidence(successCount, failureCount, outcome.verified),
        status: "candidate",
        createdAt: event.occurredAt,
        updatedAt: event.occurredAt,
        lastUsedAt: event.occurredAt,
        lastSuccessAt: success ? event.occurredAt : null,
        lastFailureAt: failure ? event.occurredAt : null,
        successCount,
        verifiedSuccessCount,
        failureCount,
        recentOutcomes: success ? ["success"] : failure ? ["failure"] : [],
        sourceEpisodeIds: unique(event.payload.sourceEpisodeIds ?? []),
        sourceRunIds: event.payload.sourceRunId
          ? [event.payload.sourceRunId]
          : [],
        sourceMemoryIds: unique(event.payload.sourceMemoryIds ?? []),
        sourceEventIds: [event.eventId],
        supersedesVersion: existing?.version ?? null,
        evidence: mergeEvidence([], event.payload.evidence ?? []),
      };
    }
    procedures.push(procedure);
    const fingerprint = procedureDefinitionHash(draft);
    const candidateStatus = procedure.status === "active"
      ? "promoted"
      : procedure.status === "quarantined" ? "rejected" : "candidate";
    const commit: LearningCommit = {
      candidate: candidateFor(
        event,
        "procedure",
        fingerprint,
        candidateStatus,
        procedure.confidence,
        this.makeId,
      ),
      procedures,
    };
    if (event.payload.failure) {
      const lessonCommit = await this.errorLessonCommit(event);
      if (lessonCommit.errorLesson) {
        commit.errorLesson = lessonCommit.errorLesson;
      }
    }
    return commit;
  }

  private async promoteErrorLesson(event: LearningEvent): Promise<LearningCommit> {
    const commit = await this.errorLessonCommit(event);
    return {
      candidate: candidateFor(
        event,
        "error_lesson",
        event.payload.failure!.fingerprint,
        commit.errorLesson?.status === "active" ? "promoted" : "candidate",
        commit.errorLesson?.confidence ?? 0,
        this.makeId,
      ),
      ...commit,
    };
  }

  private async errorLessonCommit(event: LearningEvent): Promise<LearningCommit> {
    const signature = event.payload.failure!;
    const existing = await this.repository.loadErrorLesson(
      event.namespace,
      signature.fingerprint,
    );
    const recovery = unique(event.payload.recovery ?? []);
    const recovered = event.kind === "tool_recovered" ||
      (event.payload.outcome?.verified === true && recovery.length > 0);
    const failureCount = (existing?.failureCount ?? 0) +
      (event.kind === "tool_failed" || event.kind === "procedure_failure" ? 1 : 0);
    const successCount = (existing?.successCount ?? 0) + (recovered ? 1 : 0);
    const lesson: ErrorLesson = {
      lessonId: existing?.lessonId ?? `lesson-${cleanId(this.makeId())}`,
      namespace: event.namespace,
      signature,
      rootCause: event.payload.rootCause ?? existing?.rootCause ?? null,
      rootCauseStatus: event.payload.rootCause
        ? event.payload.outcome?.verified ? "verified" : "hypothesis"
        : existing?.rootCauseStatus ?? "unknown",
      successfulRecovery: unique([
        ...(existing?.successfulRecovery ?? []),
        ...(recovered ? recovery : []),
      ]),
      unsuccessfulRecoveries: unique([
        ...(existing?.unsuccessfulRecoveries ?? []),
        ...(!recovered ? recovery : []),
      ]),
      confidence: errorLessonConfidence(successCount, failureCount, recovered),
      status: recovered && recovery.length > 0 ? "active" : "candidate",
      firstSeenAt: existing?.firstSeenAt ?? event.occurredAt,
      lastSeenAt: event.occurredAt,
      successCount,
      failureCount,
      sourceEventIds: unique([...(existing?.sourceEventIds ?? []), event.eventId]),
      sourceMemoryIds: unique([
        ...(existing?.sourceMemoryIds ?? []),
        ...(event.payload.sourceMemoryIds ?? []),
      ]),
      evidence: mergeEvidence(
        existing?.evidence ?? [],
        event.payload.evidence ?? [],
      ),
    };
    return { errorLesson: lesson };
  }

  private isBlocked(namespace: MemoryKnowledgeNamespace): boolean {
    return this.blocked.has(memoryNamespaceKey(namespace));
  }
}

export interface FailureSignatureInput {
  tool: string;
  operation: string;
  message: string;
  errorCode?: string | number | null;
  exceptionType?: string | null;
  environment?: string | null;
  httpStatus?: number | null;
  providerVersion?: string | null;
}

export function normalizeFailureSignature(
  input: FailureSignatureInput,
): FailureSignature {
  const tool = boundedLabel(input.tool, "unknown-tool");
  const operation = boundedLabel(input.operation, "unknown-operation");
  const errorCode = input.errorCode === null || input.errorCode === undefined
    ? null
    : boundedLabel(String(input.errorCode), "unknown-code");
  const exceptionType = input.exceptionType
    ? boundedLabel(input.exceptionType, "unknown-error")
    : null;
  const normalizedMessage = normalizeErrorMessage(input.message);
  const environmentFingerprint = sha256(normalize(input.environment ?? "unknown"));
  const httpStatus = Number.isSafeInteger(input.httpStatus) &&
      (input.httpStatus ?? 0) >= 100 && (input.httpStatus ?? 0) <= 599
    ? input.httpStatus ?? null
    : null;
  const providerVersion = input.providerVersion
    ? boundedLabel(input.providerVersion, "unknown-provider")
    : null;
  const fingerprint = sha256([
    normalize(tool),
    normalize(operation),
    errorCode ?? "",
    normalize(exceptionType ?? ""),
    normalizedMessage,
    environmentFingerprint,
    String(httpStatus ?? ""),
    normalize(providerVersion ?? ""),
  ].join("\0"));
  return {
    fingerprint,
    tool,
    operation,
    errorCode,
    exceptionType,
    normalizedMessage,
    environmentFingerprint,
    httpStatus,
    providerVersion,
  };
}

function normalizeErrorMessage(value: string): string {
  if (containsSecretLikeValue(value)) return "[redacted-secret-like-error]";
  return normalize(value)
    .replaceAll(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/giu, "<id>")
    .replaceAll(/\b(?:request|trace|correlation)[-_ ]?id\s*[:=]\s*\S+/giu, "request-id=<id>")
    .replaceAll(/\b20\d{2}-\d{2}-\d{2}[t ][0-9:.+\-z]+\b/giu, "<timestamp>")
    .replaceAll(/\b[a-z]:\\[^\s]+/giu, "<path>")
    .replaceAll(/(?:^|\s)\/(?:[^\s/]+\/){1,}[^\s]*/gu, " <path>")
    .replaceAll(/\b\d{6,}\b/gu, "<number>")
    .slice(0, 500);
}

function validatePayload(payload: LearningEventPayload): LearningEventPayload | null {
  if (!payload || typeof payload !== "object") return null;
  const cloned = structuredClone(payload);
  if (cloned.procedure) cloned.procedure = validateProcedureDraft(cloned.procedure);
  if (cloned.userFact) {
    const fact = cloned.userFact;
    fact.subject = boundedText(fact.subject, 160);
    fact.predicate = boundedText(fact.predicate, 160);
    fact.value = boundedText(fact.value, 1_000);
    fact.displayText = boundedText(fact.displayText, 1_000);
    fact.confidence = boundedConfidence(fact.confidence, fact.provenance);
    fact.sourceMemoryIds = boundedStrings(fact.sourceMemoryIds, 64, 256);
    fact.evidence = validateEvidence(fact.evidence);
  }
  if (cloned.recovery) cloned.recovery = boundedStrings(cloned.recovery, 16, 500);
  if (cloned.rootCause !== undefined && cloned.rootCause !== null) {
    cloned.rootCause = boundedText(cloned.rootCause, 500);
  }
  if (cloned.sourceEpisodeIds) {
    cloned.sourceEpisodeIds = boundedStrings(cloned.sourceEpisodeIds, 64, 256);
  }
  if (cloned.sourceMemoryIds) {
    cloned.sourceMemoryIds = boundedStrings(cloned.sourceMemoryIds, 64, 256);
  }
  if (cloned.evidence) cloned.evidence = validateEvidence(cloned.evidence);
  if (!cloned.userFact && !cloned.procedure && !cloned.failure) return null;
  return cloned;
}

function validateProcedureDraft(input: ProcedureDraft): ProcedureDraft {
  const steps = input.steps.slice(0, MAX_PROCEDURE_STEPS).map((step, index) => ({
    order: index + 1,
    action: boundedText(step.action, 500),
    tool: step.tool ? boundedText(step.tool, 160) : null,
    expectedOutcome: step.expectedOutcome
      ? boundedText(step.expectedOutcome, 500)
      : null,
  }));
  if (steps.length === 0) throw new Error("Procedure candidate tidak punya langkah.");
  return {
    logicalKey: boundedKey(input.logicalKey),
    name: boundedText(input.name, 160),
    description: boundedText(input.description, 1_000),
    triggerSignatures: boundedStrings(input.triggerSignatures, 16, 200),
    preconditions: boundedStrings(input.preconditions, 16, 500),
    toolRequirements: boundedStrings(input.toolRequirements, 16, 160),
    environmentConstraints: boundedStrings(input.environmentConstraints, 16, 160),
    steps,
    pitfalls: boundedStrings(input.pitfalls, 16, 500),
    recoveryStrategies: boundedStrings(input.recoveryStrategies, 16, 500),
    verification: boundedStrings(input.verification, 16, 500),
  };
}

function validateEvidence(
  input: readonly LearningEvidenceReference[],
): LearningEvidenceReference[] {
  return input.slice(0, MAX_EVIDENCE_PER_RECORD).map((evidence) => ({
    ...evidence,
    sourceId: boundedText(evidence.sourceId, 512),
    contentHash: /^[a-f0-9]{64}$/u.test(evidence.contentHash)
      ? evidence.contentHash
      : sha256(evidence.contentHash),
    occurredAt: validDate(evidence.occurredAt),
    sourceEpisodeId: evidence.sourceEpisodeId
      ? boundedText(evidence.sourceEpisodeId, 256)
      : null,
    sourceSequences: uniqueNumbers(evidence.sourceSequences)
      .filter((value) => Number.isSafeInteger(value) && value > 0)
      .slice(0, 128),
    locator: evidence.locator ? safeLocator(evidence.locator) : null,
  }));
}

function procedureDraftFromRun(
  request: string,
  observations: AgentRunResult["checkpoint"]["observations"],
): ProcedureDraft | null {
  if (containsSecretLikeValue(request)) return null;
  const tools = unique(observations.map((item) => item.capabilityId));
  const terms = (normalize(request).match(/[\p{L}\p{N}]+/gu) ?? [])
    .filter((term) => term.length >= 3).slice(0, 8);
  if (tools.length === 0 || terms.length === 0) return null;
  const logicalKey = boundedKey([...terms.slice(0, 5), ...tools.slice(0, 3)].join("-"));
  return {
    logicalKey,
    name: terms.slice(0, 6).join(" "),
    description: `Workflow terobservasi untuk ${terms.slice(0, 8).join(" ")}.`,
    triggerSignatures: terms,
    preconditions: [],
    toolRequirements: tools,
    environmentConstraints: [],
    steps: observations.slice(0, MAX_PROCEDURE_STEPS).map((item, index) => ({
      order: index + 1,
      action: `Jalankan capability ${item.capabilityId}.`,
      tool: item.capabilityId,
      expectedOutcome: item.status === "ok" ? "ok" : item.status,
    })),
    pitfalls: observations.filter((item) => item.status !== "ok")
      .map((item) => `${item.capabilityId}: ${item.status}`),
    recoveryStrategies: [],
    verification: observations.filter((item) => item.status === "ok")
      .map((item) => `Verifikasi hasil ${item.capabilityId}.`),
  };
}

function learningNamespaceForAgentScope(
  scope: AgentScope,
): MemoryKnowledgeNamespace | null {
  if (scope.kind === "private") {
    return privateMemoryNamespace(scope.userId);
  }
  // Group/workspace promotion needs the authoritative product mapping rather
  // than guessing project/member identity from transport IDs.
  return null;
}

function memoryEvidence(
  item: MemoryItem,
  input?: NewMemory,
): LearningEvidenceReference {
  return {
    kind: "conversation_message",
    sourceId: `memory:${item.id}`,
    contentHash: sha256(item.content),
    occurredAt: item.createdAt,
    sourceEpisodeId: input?.sourceEpisodeIds?.[0] ?? null,
    sourceSequences: uniqueNumbers(input?.sourceSequences ?? []),
    locator: null,
  };
}

function categoryForMemory(kind: MemoryItem["kind"]): UserModelFact["category"] | null {
  switch (kind) {
    case "profile": return "identity";
    case "preference": return "communication_preference";
    case "routine": return "routine";
    case "context": return "project";
    case "personal": return null;
  }
}

function candidateFor(
  event: LearningEvent,
  kind: LearningCandidate["kind"],
  fingerprint: string,
  status: LearningCandidate["status"],
  confidence: number,
  makeId: () => string,
): LearningCandidate {
  return {
    candidateId: `candidate-${cleanId(makeId())}`,
    namespace: event.namespace,
    kind,
    fingerprint,
    status,
    confidence,
    createdAt: event.occurredAt,
    updatedAt: event.occurredAt,
    sourceEventIds: [event.eventId],
  };
}

function renderProcedure(procedure: ProcedureMemory): string {
  const lines = [
    `Procedure ${procedure.name} v${procedure.version} (${procedure.status}).`,
    procedure.description,
    ...procedure.preconditions.map((item) => `Prasyarat: ${item}`),
    ...procedure.steps.map((step) =>
      `${step.order}. ${step.action}${step.expectedOutcome ? ` → ${step.expectedOutcome}` : ""}`),
    ...procedure.pitfalls.map((item) => `Pitfall: ${item}`),
    ...procedure.recoveryStrategies.map((item) => `Recovery: ${item}`),
    ...procedure.verification.map((item) => `Verifikasi: ${item}`),
  ];
  return clip(lines.filter(Boolean).join("\n"), 1_800);
}

function renderErrorLesson(lesson: ErrorLesson): string {
  return clip([
    `Lesson ${lesson.signature.tool}/${lesson.signature.operation}: ${lesson.signature.normalizedMessage}`,
    lesson.rootCause ? `Penyebab: ${lesson.rootCause}` : "",
    ...lesson.successfulRecovery.map((item) => `Recovery terbukti: ${item}`),
    ...lesson.unsuccessfulRecoveries.map((item) => `Tidak berhasil: ${item}`),
  ].filter(Boolean).join("\n"), 1_200);
}

function procedureRank(procedure: ProcedureMemory, environmentScore: number): number {
  const status = procedure.status === "active" ? 1
    : procedure.status === "candidate" ? 0.55
    : procedure.status === "uncertain" ? 0.35
    : procedure.status === "degraded" ? 0.15 : 0;
  const evidence = Math.min(1, procedure.verifiedSuccessCount / 4);
  const failures = Math.min(0.8, procedure.failureCount * 0.1);
  return status + procedure.confidence + evidence + environmentScore - failures;
}

function procedureConfidence(
  successes: number,
  failures: number,
  latestVerified: boolean,
): number {
  // Beta(1,1) posterior prevents a single success from looking certain.
  const posterior = (successes + 1) / (successes + failures + 2);
  return roundScore(Math.max(0.05, Math.min(0.99,
    posterior + (latestVerified ? 0.05 : 0))));
}

function errorLessonConfidence(
  successes: number,
  failures: number,
  recovered: boolean,
): number {
  const posterior = (successes + 1) / (successes + failures + 2);
  return roundScore(Math.max(0.1, Math.min(0.95,
    posterior + (recovered ? 0.1 : 0))));
}

function authorityWeight(provenance: UserModelFact["provenance"]): number {
  return provenance === "asserted" ? 1 : provenance === "observed" ? 0.7 : 0.4;
}

function effectiveFactConfidence(fact: UserModelFact, now: Date): number {
  if (fact.provenance === "asserted" || fact.stability === "stable") {
    return fact.confidence;
  }
  const ageDays = Math.max(
    0,
    (now.getTime() - Date.parse(fact.lastObservedAt)) / (24 * 60 * 60 * 1_000),
  );
  const halfLifeDays = fact.provenance === "inferred" ? 90 : 180;
  return roundScore(fact.confidence * Math.pow(0.5, ageDays / halfLifeDays));
}

function boundedConfidence(value: number, provenance: UserModelFact["provenance"]): number {
  const finite = Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
  return provenance === "inferred" ? Math.min(0.65, finite) : finite;
}

function mergeEvidence(
  left: readonly LearningEvidenceReference[],
  right: readonly LearningEvidenceReference[],
): LearningEvidenceReference[] {
  const seen = new Set<string>();
  return [...left, ...right].filter((item) => {
    const key = `${item.kind}\0${item.sourceId}\0${item.contentHash}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(-MAX_EVIDENCE_PER_RECORD);
}

function procedureDefinitionHash(procedure: ProcedureDraft): string {
  return sha256(canonicalPayload({
    logicalKey: procedure.logicalKey,
    name: procedure.name,
    description: procedure.description,
    triggerSignatures: procedure.triggerSignatures,
    preconditions: procedure.preconditions,
    toolRequirements: procedure.toolRequirements,
    environmentConstraints: procedure.environmentConstraints,
    steps: procedure.steps,
    pitfalls: procedure.pitfalls,
    recoveryStrategies: procedure.recoveryStrategies,
    verification: procedure.verification,
  }));
}

function canonicalPayload(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalPayload).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalPayload(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function validatePromotionPolicy(policy: LearningPromotionPolicy): void {
  for (const value of Object.values(policy)) {
    if (!Number.isSafeInteger(value) || value < 1 || value > 100) {
      throw new Error("Promotion policy long-term memory tidak sah.");
    }
  }
}

function safeLocator(value: string): string {
  const clean = boundedText(value, 1_000);
  if (containsSecretLikeValue(clean) || /[?&](?:token|key|secret|code)=/iu.test(clean)) {
    throw new Error("Locator evidence memuat credential.");
  }
  return clean;
}

function boundedStrings(
  values: readonly string[],
  maximumItems: number,
  maximumCharacters: number,
): string[] {
  return unique(values.slice(0, maximumItems).map((value) =>
    boundedText(value, maximumCharacters)));
}

function boundedText(value: string, maximum: number): string {
  const clean = typeof value === "string"
    ? value.trim().replaceAll(/\s+/gu, " ")
    : "";
  if (!clean || clean.length > maximum || /\p{Cc}/u.test(clean)) {
    throw new Error("Teks learning memory tidak sah.");
  }
  return clean;
}

function boundedLabel(value: string, fallback: string): string {
  try {
    return boundedText(value, 160);
  } catch {
    return fallback;
  }
}

function boundedKey(value: string): string {
  const normalized = normalize(value).replaceAll(/[^a-z0-9]+/gu, "-")
    .replaceAll(/^-+|-+$/gu, "").slice(0, 120);
  if (!normalized) throw new Error("Logical key procedure tidak sah.");
  return normalized;
}

function validDate(value: string): string {
  if (!Number.isFinite(Date.parse(value))) throw new Error("Tanggal evidence tidak sah.");
  return value;
}

function normalize(value: string): string {
  return value.normalize("NFKD").replaceAll(/\p{M}+/gu, "")
    .toLocaleLowerCase("id-ID").replaceAll(/\s+/gu, " ").trim();
}

function clip(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum - 1).trimEnd()}…`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function cleanId(value: string): string {
  const clean = value.replaceAll(/[^A-Za-z0-9]/gu, "").slice(0, 24);
  return clean || sha256(value).slice(0, 24);
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function uniqueNumbers(values: readonly number[]): number[] {
  return [...new Set(values)].sort((left, right) => left - right);
}

function roundScore(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
