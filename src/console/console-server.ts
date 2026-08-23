import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import type {
  ConsoleAuditAction,
  Enrollment,
  GroupRuntimeMode,
} from "../domain/control-plane.js";
import type { PlanComputePolicy } from "../domain/economy.js";
import type {
  RuntimeEnvironment,
  UsageCostCenter,
  UsageLedgerFilter,
} from "../domain/usage-ledger.js";
import {
  ControlPlaneConflictError,
  ControlPlaneService,
  ControlPlaneValidationError,
} from "../core/control-plane-service.js";
import type { UsageLedgerService } from "../core/usage-ledger-service.js";
import type { EconomyService } from "../core/economy-service.js";
import {
  NOOP_OPERATIONAL_LOGGER,
  type OperationalLogger,
} from "../observability/operational-logger.js";
import {
  ChannelSetupError,
  type ChannelSetupService,
  type WhatsAppTestRole,
} from "../operations/channel-setup.js";
import { CONSOLE_CSS, CONSOLE_HTML, CONSOLE_JS } from "./assets.js";

const SESSION_COOKIE = "harvy_console_session";
const BODY_LIMIT_BYTES = 64 * 1024;
const SESSION_IDLE_MS = 30 * 60 * 1_000;
const SESSION_ABSOLUTE_MS = 8 * 60 * 60 * 1_000;

type ConsoleProviderAttempt = Awaited<ReturnType<UsageLedgerService["allAttempts"]>>[number];

export interface ConsoleServerOptions {
  host: string;
  port: number;
  operatorToken?: string | null;
  sessionIdleMs?: number;
  sessionAbsoluteMs?: number;
  setupOnly?: boolean;
}

export interface ConsoleStartResult {
  origin: string;
  generatedOperatorToken: string | null;
}

interface OperatorSession {
  id: string;
  ref: string;
  csrf: string;
  createdAt: number;
  lastSeenAt: number;
}

interface RateWindow {
  startedAt: number;
  count: number;
}

interface MutationDescriptor {
  action: ConsoleAuditAction;
  targetRef: string | null;
}

export class ConsoleServer {
  private server: Server | null = null;
  private origin: string | null = null;
  private readonly sessions = new Map<string, OperatorSession>();
  private readonly loginRates = new Map<string, RateWindow>();
  private readonly mutationRates = new Map<string, RateWindow>();
  private readonly operatorToken: string;
  private readonly generatedOperatorToken: string | null;
  private lifecycle: "stopped" | "starting" | "ready" | "draining" = "stopped";
  private activeMutations = 0;
  private mutationDrainResolvers: (() => void)[] = [];
  private readonly logger: OperationalLogger;

  constructor(
    private readonly controlPlane: ControlPlaneService,
    private readonly usageLedger: UsageLedgerService,
    private readonly options: ConsoleServerOptions,
    logger: OperationalLogger =
      NOOP_OPERATIONAL_LOGGER.child("console.server"),
    private readonly now: () => number = () => Date.now(),
    private readonly economy: EconomyService | null = null,
    private readonly channelSetup: ChannelSetupService | null = null,
  ) {
    if (options.host !== "127.0.0.1") {
      throw new Error("Harvy Console local-first hanya boleh bind ke 127.0.0.1.");
    }
    if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65_535) {
      throw new Error("Port Harvy Console tidak sah.");
    }
    const configured = options.operatorToken?.trim() || null;
    if (configured !== null && configured.length < 32) {
      throw new Error("Token operator Console minimal 32 karakter.");
    }
    this.generatedOperatorToken = configured === null
      ? randomBytes(32).toString("base64url")
      : null;
    this.operatorToken = configured ?? this.generatedOperatorToken!;
    this.logger = logger;
  }

  async start(): Promise<ConsoleStartResult> {
    if (this.server || this.origin) throw new Error("Console sudah berjalan.");
    await this.channelSetup?.initialize();
    await this.controlPlane.initialize();
    const server = createServer((request, response) => {
      void this.handle(request, response).catch((error: unknown) => {
        const requestError = asRequestError(error);
        if (requestError) {
          if (!response.headersSent) {
            applySecurityHeaders(response);
            sendJson(
              response,
              requestError.status,
              apiError(requestError.code, requestError.message),
            );
          } else if (!response.writableEnded) {
            response.end();
          }
          return;
        }
        this.logger.error(
          "console_request_failed",
          "Request Console gagal di boundary HTTP.",
          error,
        );
        if (!response.headersSent) {
          applySecurityHeaders(response);
          sendJson(response, 500, apiError("internal_error", "Console gagal memproses permintaan."));
        } else if (!response.writableEnded) {
          response.end();
        }
      });
    });
    this.server = server;
    this.lifecycle = "starting";
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        server.off("listening", onListening);
        reject(error);
      };
      const onListening = (): void => {
        server.off("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(this.options.port, this.options.host);
    });
    const address = server.address() as AddressInfo | null;
    if (!address) throw new Error("Alamat Console tidak tersedia.");
    this.origin = `http://${this.options.host}:${address.port}`;
    this.logger.info(
      "console_started",
      "Harvy Console lokal mulai menerima koneksi loopback.",
      { port: address.port },
    );
    return {
      origin: this.origin,
      generatedOperatorToken: this.generatedOperatorToken,
    };
  }

  markReady(): void {
    if (this.lifecycle === "starting") this.lifecycle = "ready";
  }

  stopMutations(): void {
    if (this.lifecycle !== "stopped") this.lifecycle = "draining";
  }

  async drainMutations(): Promise<void> {
    if (this.activeMutations === 0) return;
    await new Promise<void>((resolve) => this.mutationDrainResolvers.push(resolve));
  }

  async close(): Promise<void> {
    this.stopMutations();
    await this.drainMutations();
    const server = this.server;
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
    this.server = null;
    this.origin = null;
    this.lifecycle = "stopped";
    this.sessions.clear();
    await this.channelSetup?.close();
    this.logger.info("console_stopped", "Harvy Console lokal berhenti.");
  }

  private async handle(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    applySecurityHeaders(response);
    if (!isLoopback(request.socket.remoteAddress)) {
      sendJson(response, 403, apiError("loopback_required", "Akses ditolak."));
      return;
    }
    if (!this.origin || request.headers.host !== new URL(this.origin).host) {
      sendJson(response, 421, apiError("host_rejected", "Host Console tidak dikenali."));
      return;
    }
    const url = new URL(request.url ?? "/", this.origin);
    if (url.pathname === "/" && request.method === "GET") {
      sendText(response, 200, "text/html; charset=utf-8", CONSOLE_HTML);
      return;
    }
    if (url.pathname === "/app.css" && request.method === "GET") {
      sendText(response, 200, "text/css; charset=utf-8", CONSOLE_CSS);
      return;
    }
    if (url.pathname === "/app.js" && request.method === "GET") {
      sendText(response, 200, "text/javascript; charset=utf-8", CONSOLE_JS);
      return;
    }
    if (url.pathname === "/api/v1/health" && request.method === "GET") {
      sendJson(response, 200, { status: this.lifecycle });
      return;
    }
    if (url.pathname === "/api/v1/session") {
      await this.handleSession(request, response);
      return;
    }

    const session = this.requireSession(request);
    if (!session) {
      sendJson(response, 401, apiError("authentication_required", "Sesi operator diperlukan."));
      return;
    }

    if (request.method === "GET") {
      await this.handleRead(url, response);
      return;
    }

    const mutation = describeMutation(url, request.method);
    try {
      this.requireMutationGuards(request, session);
    } catch (error) {
      await this.controlPlane.audit(
        session.ref,
        mutation.action,
        mutation.targetRef,
        "rejected",
        errorCode(error),
      );
      throw error;
    }
    await this.handleMutation(url, request, response, session, mutation);
  }

  private async handleSession(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    if (request.method === "POST") {
      let session: OperatorSession;
      try {
        this.requireOrigin(request);
        this.requireJson(request);
        const remote = request.socket.remoteAddress ?? "loopback";
        if (!this.consumeRate(this.loginRates, remote, 10, 60_000)) {
          throw new HttpError(429, "rate_limited", "Terlalu banyak percobaan masuk.");
        }
        const body = await readJsonObject(request);
        assertExactKeys(body, ["token"]);
        const token = readString(body.token, "token", 512);
        if (!constantEqual(token, this.operatorToken)) {
          throw new HttpError(401, "invalid_credentials", "Token operator tidak cocok.");
        }
        const at = this.now();
        session = {
          id: randomBytes(32).toString("base64url"),
          ref: `session_${randomBytes(9).toString("hex")}`,
          csrf: randomBytes(24).toString("base64url"),
          createdAt: at,
          lastSeenAt: at,
        };
      } catch (error) {
        await this.controlPlane.audit(
          "anonymous",
          "session_login",
          null,
          error instanceof HttpError ? "rejected" : "failed",
          errorCode(error),
        );
        throw error;
      }
      this.sessions.set(session.id, session);
      response.setHeader(
        "set-cookie",
        `${SESSION_COOKIE}=${session.id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(this.absoluteSessionMs() / 1_000)}`,
      );
      await this.controlPlane.audit(
        session.ref,
        "session_login",
        null,
        "succeeded",
      );
      sendJson(response, 201, {
        authenticated: true,
        csrfToken: session.csrf,
        setupOnly: this.options.setupOnly === true,
      });
      return;
    }

    const session = this.requireSession(request);
    if (request.method === "GET") {
      if (!session) {
        sendJson(response, 401, apiError("authentication_required", "Sesi operator diperlukan."));
        return;
      }
      sendJson(response, 200, {
        authenticated: true,
        csrfToken: session.csrf,
        setupOnly: this.options.setupOnly === true,
      });
      return;
    }
    if (request.method === "DELETE") {
      if (!session) {
        sendJson(response, 401, apiError("authentication_required", "Sesi operator diperlukan."));
        return;
      }
      await this.runMutation(session, "session_logout", null, async () => {
        this.requireMutationGuards(request, session);
        const body = await readJsonObject(request);
        assertExactKeys(body, []);
        this.sessions.delete(session.id);
        return null;
      });
      response.setHeader(
        "set-cookie",
        `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`,
      );
      sendJson(response, 200, { authenticated: false });
      return;
    }
    sendJson(response, 405, apiError("method_not_allowed", "Method tidak didukung."));
  }

  private async handleRead(url: URL, response: ServerResponse): Promise<void> {
    if (url.pathname === "/api/v1/channel-setup") {
      if (!this.channelSetup) {
        throw new HttpError(
          503,
          "channel_setup_unavailable",
          "Pengelola kanal belum dikonfigurasi.",
        );
      }
      sendJson(response, 200, await this.channelSetup.snapshot());
      return;
    }
    if (url.pathname === "/api/v1/channel-setup/telegram/qr.svg") {
      if (!this.channelSetup) {
        throw new HttpError(503, "channel_setup_unavailable", "Pengelola kanal belum dikonfigurasi.");
      }
      sendText(
        response,
        200,
        "image/svg+xml; charset=utf-8",
        this.channelSetup.qrSvg("telegram"),
      );
      return;
    }
    const whatsappQr = /^\/api\/v1\/channel-setup\/whatsapp\/(harvy|tester)\/qr\.svg$/u.exec(
      url.pathname,
    );
    if (whatsappQr?.[1]) {
      if (!this.channelSetup) {
        throw new HttpError(503, "channel_setup_unavailable", "Pengelola kanal belum dikonfigurasi.");
      }
      sendText(
        response,
        200,
        "image/svg+xml; charset=utf-8",
        this.channelSetup.qrSvg("whatsapp", whatsappQr[1] as WhatsAppTestRole),
      );
      return;
    }
    if (this.options.setupOnly === true) {
      sendJson(response, 404, apiError("not_found", "Endpoint tidak tersedia pada mode setup."));
      return;
    }
    if (url.pathname === "/api/v1/dashboard") {
      const since = new Date(this.now() - 24 * 60 * 60 * 1_000).toISOString();
      const [usage, entitlement, breakdown, attempts] = await Promise.all([
        this.usageLedger.summary({ since }),
        this.usageLedger.entitlementSummary(since),
        this.usageLedger.breakdown({ since }),
        this.usageLedger.allAttempts({ since }),
      ]);
      const control = await this.controlPlane.dashboardState();
      const economy = this.economy ? await this.economy.operatorSnapshot() : null;
      sendJson(response, 200, {
        status: this.lifecycle,
        usage,
        entitlement,
        breakdown,
        subjects: control.enrollments.length,
        betaSubjects: control.enrollments.filter((item) => item.cohort === "beta").length,
        planVersions: control.plans.length,
        priceVersions: control.prices.length,
        economy: economy
          ? {
              version: economy.version,
              reservations: economy.reservations.length,
              settlements: economy.settlements.length,
              walletAccounts: economy.walletAccounts.length,
              walletTransactions: economy.walletTransactions.length,
              payments: economy.payments.length,
              contributions: economy.contributions.length,
              activeCredentials: economy.credentials.filter(
                (item) => item.status === "active",
              ).length,
              ledgerEntries: economy.ledger.length,
              logicalBillableComputeUnits: economy.settlements
                .filter((item) => item.outcome === "charged")
                .reduce((sum, item) => sum + BigInt(item.billableComputeUnits), 0n)
                .toString(),
              releasedComputeUnits: economy.settlements
                .filter((item) => item.outcome === "released")
                .reduce((sum, item) => sum + BigInt(item.measuredComputeUnits), 0n)
                .toString(),
              physicalProviderCostUsdNanos: usage.providerReportedUsdNanos,
              localCalculatedProviderCostUsdNanos: usage.localCalculatedUsdNanos,
              physicalCostByFundingSource: fundingCostBreakdown(attempts),
            }
          : null,
      });
      return;
    }
    if (url.pathname === "/api/v1/control-plane") {
      sendJson(response, 200, await this.controlPlane.dashboardState());
      return;
    }
    if (url.pathname === "/api/v1/enrollments" || url.pathname === "/api/v1/entitlements") {
      sendJson(response, 200, { records: await this.controlPlane.enrollments() });
      return;
    }
    if (url.pathname === "/api/v1/evaluation-consents") {
      const records = (await this.controlPlane.enrollments()).map((item) => ({
        subjectRef: item.subjectRef,
        version: item.version,
        consent: item.evaluationConsent,
      }));
      sendJson(response, 200, { records });
      return;
    }
    if (url.pathname === "/api/v1/plans") {
      sendJson(response, 200, { records: await this.controlPlane.plans() });
      return;
    }
    if (url.pathname === "/api/v1/prices") {
      sendJson(response, 200, { records: await this.controlPlane.prices() });
      return;
    }
    if (url.pathname === "/api/v1/usage") {
      const filter = usageFilter(url.searchParams);
      const [summary, attempts] = await Promise.all([
        this.usageLedger.summary(filter),
        this.usageLedger.attempts(filter),
      ]);
      const costViews = await this.usageLedger.costViews(attempts);
      sendJson(response, 200, {
        summary,
        attempts: attempts.map((attempt) => ({
          ...attempt,
          costView: costViews.get(attempt.attemptId),
        })),
      });
      return;
    }
    if (url.pathname === "/api/v1/economy") {
      if (!this.economy) {
        sendJson(response, 503, apiError("economy_unavailable", "Economy belum tersedia."));
        return;
      }
      sendJson(response, 200, await this.economy.operatorSnapshot());
      return;
    }
    if (url.pathname === "/api/v1/groups") {
      const groups = (await this.controlPlane.enrollments()).filter(
        (item) => item.kind === "group",
      );
      sendJson(response, 200, { records: groups });
      return;
    }
    const memberMatch = /^\/api\/v1\/groups\/([^/]+)\/members$/u.exec(url.pathname);
    if (memberMatch?.[1]) {
      const subjectRef = decodeSafeRef(memberMatch[1]);
      const attempts = await this.usageLedger.allAttempts({ subjectRef });
      const costViews = await this.usageLedger.costViews(attempts);
      const totals = new Map<string, {
        attempts: number;
        tokens: number;
        knownCostUsdNanos: bigint;
        indicativeCostUsdNanos: bigint;
        currentPriceEstimateUsdNanos: bigint;
        pricedAttempts: number;
        unpricedAttempts: number;
        currentPriceEstimatedAttempts: number;
        unavailableCostAttempts: number;
        historicalPriceGapAttempts: number;
        missingUsageAttempts: number;
        pendingAttempts: number;
      }>();
      for (const attempt of attempts) {
        const key = attempt.actorRef ?? "shared";
        const current = totals.get(key) ?? {
          attempts: 0,
          tokens: 0,
          knownCostUsdNanos: 0n,
          indicativeCostUsdNanos: 0n,
          currentPriceEstimateUsdNanos: 0n,
          pricedAttempts: 0,
          unpricedAttempts: 0,
          currentPriceEstimatedAttempts: 0,
          unavailableCostAttempts: 0,
          historicalPriceGapAttempts: 0,
          missingUsageAttempts: 0,
          pendingAttempts: 0,
        };
        current.attempts += 1;
        current.tokens += attempt.usage.totalTokens;
        if (attempt.cost.effectiveUsdNanos === null) {
          current.unpricedAttempts += 1;
        } else {
          current.pricedAttempts += 1;
          current.knownCostUsdNanos += BigInt(attempt.cost.effectiveUsdNanos);
        }
        const costView = costViews.get(attempt.attemptId);
        if (costView?.costUsdNanos !== null && costView?.costUsdNanos !== undefined) {
          current.indicativeCostUsdNanos += BigInt(costView.costUsdNanos);
        }
        if (costView?.source === "current_catalog_estimate") {
          current.currentPriceEstimatedAttempts += 1;
          current.currentPriceEstimateUsdNanos += BigInt(costView.costUsdNanos!);
        } else if (costView?.source === "unavailable") {
          current.unavailableCostAttempts += 1;
        }
        if (costView?.reason === "historical_price_missing") {
          current.historicalPriceGapAttempts += 1;
        } else if (costView?.reason === "usage_missing") {
          current.missingUsageAttempts += 1;
        }
        if (
          attempt.status === "started" ||
          attempt.cost.reconciliation === "pending"
        ) {
          current.pendingAttempts += 1;
        }
        totals.set(key, current);
      }
      sendJson(response, 200, {
        records: [...totals].map(([actorRef, value]) => ({
          actorRef,
          attempts: value.attempts,
          tokens: value.tokens,
          costUsdNanos:
            value.pricedAttempts === 0
              ? null
              : value.knownCostUsdNanos.toString(),
          indicativeCostUsdNanos:
            value.currentPriceEstimatedAttempts + value.pricedAttempts === 0
              ? null
              : value.indicativeCostUsdNanos.toString(),
          currentPriceEstimateUsdNanos:
            value.currentPriceEstimateUsdNanos.toString(),
          currentPriceEstimatedAttempts: value.currentPriceEstimatedAttempts,
          unavailableCostAttempts: value.unavailableCostAttempts,
          historicalPriceGapAttempts: value.historicalPriceGapAttempts,
          missingUsageAttempts: value.missingUsageAttempts,
          costCoverage:
            value.currentPriceEstimatedAttempts === 0 &&
              value.unavailableCostAttempts === 0
              ? "complete"
              : value.unavailableCostAttempts === 0
                ? "estimated"
                : value.pricedAttempts + value.currentPriceEstimatedAttempts > 0
                  ? "partial"
                  : "unavailable",
          costCompleteness:
            value.unpricedAttempts === 0 && value.pendingAttempts === 0
              ? "complete"
              : value.pricedAttempts === 0
                ? "unknown"
                : "partial",
          pricedAttempts: value.pricedAttempts,
          unpricedAttempts: value.unpricedAttempts,
          pendingAttempts: value.pendingAttempts,
        })),
      });
      return;
    }
    if (url.pathname === "/api/v1/audit") {
      sendJson(response, 200, { records: await this.controlPlane.audits() });
      return;
    }
    sendJson(response, 404, apiError("not_found", "Endpoint tidak ditemukan."));
  }

  private async handleMutation(
    url: URL,
    request: IncomingMessage,
    response: ServerResponse,
    session: OperatorSession,
    mutation: MutationDescriptor,
  ): Promise<void> {
    if (this.lifecycle !== "ready") {
      await this.controlPlane.audit(
        session.ref,
        mutation.action,
        mutation.targetRef,
        "rejected",
        this.lifecycle,
      );
      throw new HttpError(
        503,
        this.lifecycle,
        this.lifecycle === "starting"
          ? "Console belum siap menerima perubahan."
          : "Console sedang ditutup.",
      );
    }
    if (!this.consumeRate(this.mutationRates, session.id, 120, 60_000)) {
      await this.controlPlane.audit(
        session.ref,
        mutation.action,
        mutation.targetRef,
        "rejected",
        "rate_limited",
      );
      throw new HttpError(429, "rate_limited", "Terlalu banyak perubahan.");
    }
    this.activeMutations += 1;
    try {
      if (url.pathname.startsWith("/api/v1/channel-setup/")) {
        const setup = this.channelSetup;
        if (!setup) {
          throw new HttpError(
            503,
            "channel_setup_unavailable",
            "Pengelola kanal belum dikonfigurasi.",
          );
        }
        if (
          url.pathname === "/api/v1/channel-setup/telegram/bot-token" &&
          request.method === "POST"
        ) {
          await this.runMutation(session, "channel_credential_update", "telegram_bot", async () => {
            const body = await readJsonObject(request);
            assertExactKeys(body, ["token"]);
            await setup.setTelegramBotToken(readString(body.token, "token", 256));
          });
          sendJson(response, 200, { updated: true });
          return;
        }
        if (
          url.pathname === "/api/v1/channel-setup/telegram/bot-token" &&
          request.method === "DELETE"
        ) {
          await this.runMutation(session, "channel_credential_revoke", "telegram_bot", async () => {
            const body = await readJsonObject(request);
            requireConfirmation(body, "DELETE_TELEGRAM_TEST_BOT");
            await setup.deleteTelegramBotToken();
          });
          sendJson(response, 200, { deleted: true });
          return;
        }
        if (
          url.pathname === "/api/v1/channel-setup/telegram/tester/pair" &&
          request.method === "POST"
        ) {
          await this.runMutation(session, "channel_pairing_start", "telegram_tester", async () => {
            const body = await readJsonObject(request);
            assertExactKeys(body, ["apiId", "apiHash", "confirmation"]);
            requireConfirmation(body, "DEDICATED_TEST_ACCOUNT", ["apiId", "apiHash"]);
            setup.startTelegramTester({
              apiId: readInteger(body.apiId),
              apiHash: readString(body.apiHash, "apiHash", 64),
            });
          });
          sendJson(response, 202, { accepted: true });
          return;
        }
        if (
          url.pathname === "/api/v1/channel-setup/telegram/tester/password" &&
          request.method === "POST"
        ) {
          await this.runMutation(session, "channel_credential_update", "telegram_tester", async () => {
            const body = await readJsonObject(request);
            assertExactKeys(body, ["password"]);
            setup.submitTelegramPassword(readOpaqueSecret(body.password, "password", 256));
          });
          sendJson(response, 202, { accepted: true });
          return;
        }
        if (
          url.pathname === "/api/v1/channel-setup/telegram/tester/cancel" &&
          request.method === "POST"
        ) {
          await this.runMutation(session, "channel_pairing_cancel", "telegram_tester", async () => {
            const body = await readJsonObject(request);
            assertExactKeys(body, []);
            await setup.cancelTelegramTester();
          });
          sendJson(response, 200, { cancelled: true });
          return;
        }
        if (
          url.pathname === "/api/v1/channel-setup/telegram/tester" &&
          request.method === "DELETE"
        ) {
          await this.runMutation(session, "channel_credential_revoke", "telegram_tester", async () => {
            const body = await readJsonObject(request);
            requireConfirmation(body, "DELETE_TELEGRAM_TEST_SESSION");
            setup.startTelegramTesterRevoke();
          });
          sendJson(response, 202, { accepted: true });
          return;
        }

        const whatsappOperation = /^\/api\/v1\/channel-setup\/whatsapp\/(harvy|tester)\/(pair|replace|cancel|session)$/u.exec(
          url.pathname,
        );
        if (whatsappOperation?.[1] && whatsappOperation[2]) {
          const role = whatsappOperation[1] as WhatsAppTestRole;
          const operation = whatsappOperation[2];
          if (operation === "pair" && request.method === "POST") {
            await this.runMutation(session, "channel_pairing_start", `whatsapp_${role}`, async () => {
              const body = await readJsonObject(request);
              requireConfirmation(body, "DEDICATED_TEST_ACCOUNT");
              setup.startWhatsApp(role);
            });
            sendJson(response, 202, { accepted: true });
            return;
          }
          if (operation === "replace" && request.method === "POST") {
            await this.runMutation(session, "channel_credential_update", `whatsapp_${role}`, async () => {
              const body = await readJsonObject(request);
              requireConfirmation(
                body,
                role === "harvy"
                  ? "REPLACE_WHATSAPP_HARVY_SESSION"
                  : "REPLACE_WHATSAPP_TESTER_SESSION",
              );
              setup.startWhatsAppReplace(role);
            });
            sendJson(response, 202, { accepted: true });
            return;
          }
          if (operation === "cancel" && request.method === "POST") {
            await this.runMutation(session, "channel_pairing_cancel", `whatsapp_${role}`, async () => {
              const body = await readJsonObject(request);
              assertExactKeys(body, []);
              await setup.cancelWhatsApp(role);
            });
            sendJson(response, 200, { cancelled: true });
            return;
          }
          if (operation === "session" && request.method === "DELETE") {
            await this.runMutation(session, "channel_credential_revoke", `whatsapp_${role}`, async () => {
              const body = await readJsonObject(request);
              requireConfirmation(
                body,
                role === "harvy"
                  ? "REVOKE_WHATSAPP_HARVY_SESSION"
                  : "REVOKE_WHATSAPP_TESTER_SESSION",
              );
              setup.startWhatsAppRevoke(role);
            });
            sendJson(response, 202, { accepted: true });
            return;
          }
        }
      }

      if (this.options.setupOnly === true) {
        await this.controlPlane.audit(
          session.ref,
          mutation.action,
          mutation.targetRef,
          "rejected",
          "not_found",
        );
        throw new HttpError(404, "not_found", "Endpoint tidak tersedia pada mode setup.");
      }

      if (url.pathname === "/api/v1/enrollments" && request.method === "POST") {
        const created = await this.runMutation(
          session,
          "enrollment_create",
          null,
          async () => {
            const body = await readJsonObject(request);
            assertExactKeys(body, ["kind", "channel", "externalId", "operatorLabel"], true);
            return this.controlPlane.createEnrollmentFromExternal(
              readString(body.externalId, "externalId", 256),
              {
                kind: readEnum(body.kind, ["private", "group"] as const),
                channel: readEnum(
                  body.channel,
                  ["telegram", "whatsapp", "system"] as const,
                ),
              },
              readNullableString(body.operatorLabel, 64),
            );
          },
        );
        sendJson(response, 201, created);
        return;
      }

      const enrollmentMatch = /^\/api\/v1\/enrollments\/([^/]+)$/u.exec(url.pathname);
      if (enrollmentMatch?.[1] && request.method === "PUT") {
        const subjectRef = decodeSafeRef(enrollmentMatch[1]);
        const updated = await this.runMutation(
          session,
          "enrollment_update",
          subjectRef,
          async () => {
            const body = await readJsonObject(request);
            assertExactKeys(body, [
              "operatorLabel",
              "cohort",
              "planId",
              "quotaOverride",
              "betaExpiresAt",
              "groupRuntimeMode",
            ], true);
            return this.controlPlane.updateEnrollment(
              subjectRef,
              readExpectedVersion(request),
              enrollmentPatch(body),
            );
          },
        );
        sendJson(response, 200, updated);
        return;
      }

      const consentMatch = /^\/api\/v1\/evaluation-consents\/([^/]+)\/(invite|revoke)$/u.exec(url.pathname);
      if (consentMatch?.[1] && consentMatch[2] && request.method === "POST") {
        const subjectRef = decodeSafeRef(consentMatch[1]);
        const operation = consentMatch[2];
        const updated = await this.runMutation(
          session,
          operation === "invite" ? "evaluation_invite" : "evaluation_revoke",
          subjectRef,
          async () => {
            const body = await readJsonObject(request);
            assertExactKeys(body, []);
            const version = readExpectedVersion(request);
            return operation === "invite"
              ? this.controlPlane.inviteEvaluation(subjectRef, version)
              : this.controlPlane.revokeEvaluation(subjectRef, version);
          },
        );
        sendJson(response, 200, updated);
        return;
      }

      if (url.pathname === "/api/v1/economy/credentials" && request.method === "POST") {
        const created = await this.runMutation(
          session,
          "economy_credential_create",
          null,
          async () => {
            if (!this.economy?.secureByokSetupAvailable) {
              throw new HttpError(
                503,
                "byok_setup_unavailable",
                "Secure BYOK secret store belum dikonfigurasi.",
              );
            }
            const body = await readJsonObject(request);
            assertExactKeys(body, [
              "subjectRef",
              "providerId",
              "baseUrl",
              "modelId",
              "eligibleTiers",
              "apiKey",
            ]);
            return this.economy.registerCredentialForSubject({
              subjectRef: readString(body.subjectRef, "subjectRef", 256),
              providerId: readString(body.providerId, "providerId", 160),
              baseUrl: readString(body.baseUrl, "baseUrl", 2_048),
              modelId: readString(body.modelId, "modelId", 160),
              eligibleTiers: readUsageTiers(body.eligibleTiers),
              apiKey: readString(body.apiKey, "apiKey", 4_096),
            });
          },
        );
        sendJson(response, 201, created);
        return;
      }

      const credentialMatch = /^\/api\/v1\/economy\/credentials\/([^/]+)$/u.exec(url.pathname);
      if (credentialMatch?.[1] && request.method === "DELETE") {
        const credentialRef = decodeSafeRef(credentialMatch[1]);
        await this.runMutation(
          session,
          "economy_credential_revoke",
          credentialRef,
          async () => {
            if (!this.economy) {
              throw new HttpError(503, "economy_unavailable", "Economy belum tersedia.");
            }
            const body = await readJsonObject(request);
            assertExactKeys(body, ["subjectRef"]);
            await this.economy.revokeCredentialForSubject(
              readString(body.subjectRef, "subjectRef", 256),
              credentialRef,
            );
          },
        );
        sendJson(response, 200, { revoked: true });
        return;
      }

      if (url.pathname === "/api/v1/plans/versions" && request.method === "POST") {
        const created = await this.runMutation(
          session,
          "plan_version_create",
          null,
          async () => {
            const body = await readJsonObject(request);
            const required = [
              "planId", "publicName", "audience", "monthlyPriceIdr",
              "rolling24hTokenLimit", "activeMemberLimit", "groupMode",
              "status", "effectiveFrom",
            ] as const;
            assertExactKeys(body, [...required, "computePolicy"], true);
            assertRequiredKeys(body, required);
            const computePolicy = readPlanComputePolicy(body.computePolicy);
            return this.controlPlane.createPlanVersion({
              planId: readString(body.planId, "planId", 160),
              publicName: readString(body.publicName, "publicName", 40),
              audience: readEnum(body.audience, ["personal", "group", "workspace"] as const),
              monthlyPriceIdr: readInteger(body.monthlyPriceIdr),
              rolling24hTokenLimit: readInteger(body.rolling24hTokenLimit),
              activeMemberLimit: readNullableInteger(body.activeMemberLimit),
              groupMode: readEnum(body.groupMode, ["none", "direct_only", "ambient", "workspace"] as const),
              status: readEnum(body.status, ["pilot", "active", "retired"] as const),
              effectiveFrom: readString(body.effectiveFrom, "effectiveFrom", 40),
              ...(computePolicy ? { computePolicy } : {}),
            });
          },
        );
        sendJson(response, 201, created);
        return;
      }

      if (url.pathname === "/api/v1/prices/versions" && request.method === "POST") {
        const created = await this.runMutation(
          session,
          "price_version_create",
          null,
          async () => {
            const body = await readJsonObject(request);
            assertExactKeys(body, [
              "providerId", "modelId", "inputPerMillionUsd",
              "outputPerMillionUsd", "cacheReadPerMillionUsd",
              "cacheWritePerMillionUsd", "reasoningPerMillionUsd",
              "perRequestUsd", "status", "effectiveFrom",
            ], true);
            return this.controlPlane.createPriceVersion({
              providerId: readString(body.providerId, "providerId", 160),
              modelId: readString(body.modelId, "modelId", 160),
              rates: {
                inputPerMillionUsd: readString(body.inputPerMillionUsd, "inputPerMillionUsd", 64),
                outputPerMillionUsd: readString(body.outputPerMillionUsd, "outputPerMillionUsd", 64),
                cacheReadPerMillionUsd: readNullableString(body.cacheReadPerMillionUsd, 64),
                cacheWritePerMillionUsd: readNullableString(body.cacheWritePerMillionUsd, 64),
                reasoningPerMillionUsd: readNullableString(body.reasoningPerMillionUsd, 64),
                perRequestUsd: readNullableString(body.perRequestUsd, 64),
              },
              status: body.status === undefined
                ? "pilot"
                : readEnum(body.status, ["pilot", "active", "retired"] as const),
              effectiveFrom: readString(body.effectiveFrom, "effectiveFrom", 40),
            });
          },
        );
        sendJson(response, 201, created);
        return;
      }
      await this.controlPlane.audit(
        session.ref,
        mutation.action,
        mutation.targetRef,
        "rejected",
        "not_found",
      );
      throw new HttpError(404, "not_found", "Endpoint tidak ditemukan.");
    } finally {
      this.activeMutations -= 1;
      if (this.activeMutations === 0) {
        const resolvers = this.mutationDrainResolvers;
        this.mutationDrainResolvers = [];
        for (const resolve of resolvers) resolve();
      }
    }
  }

  private async runMutation<T>(
    session: OperatorSession,
    action: ConsoleAuditAction,
    targetRef: string | null,
    operation: () => Promise<T>,
  ): Promise<T> {
    try {
      const result = await operation();
      const resolvedTarget = targetRef ?? enrollmentTarget(result);
      await this.controlPlane.audit(
        session.ref,
        action,
        resolvedTarget,
        "succeeded",
      );
      return result;
    } catch (error) {
      await this.controlPlane.audit(
        session.ref,
        action,
        targetRef,
        error instanceof ControlPlaneValidationError ||
          error instanceof ControlPlaneConflictError ||
          error instanceof HttpError ||
          (error instanceof ChannelSetupError && error.status < 500)
          ? "rejected"
          : "failed",
        errorCode(error),
      );
      throw error;
    }
  }

  private requireSession(request: IncomingMessage): OperatorSession | null {
    const id = parseCookies(request.headers.cookie ?? "").get(SESSION_COOKIE);
    if (!id) return null;
    const session = this.sessions.get(id);
    if (!session) return null;
    const at = this.now();
    if (
      at - session.lastSeenAt > this.idleSessionMs() ||
      at - session.createdAt > this.absoluteSessionMs()
    ) {
      this.sessions.delete(id);
      return null;
    }
    session.lastSeenAt = at;
    return session;
  }

  private requireMutationGuards(
    request: IncomingMessage,
    session: OperatorSession,
  ): void {
    this.requireOrigin(request);
    this.requireJson(request);
    if (!constantEqual(request.headers["x-csrf-token"] ?? "", session.csrf)) {
      throw new HttpError(403, "csrf_rejected", "CSRF token tidak cocok.");
    }
  }

  private requireOrigin(request: IncomingMessage): void {
    if (!this.origin || request.headers.origin !== this.origin) {
      throw new HttpError(403, "origin_rejected", "Origin Console tidak cocok.");
    }
  }

  private requireJson(request: IncomingMessage): void {
    if (!(request.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
      throw new HttpError(415, "json_required", "Content-Type JSON diperlukan.");
    }
  }

  private consumeRate(
    source: Map<string, RateWindow>,
    key: string,
    maximum: number,
    durationMs: number,
  ): boolean {
    const at = this.now();
    const current = source.get(key);
    if (!current || at - current.startedAt >= durationMs) {
      source.set(key, { startedAt: at, count: 1 });
      return true;
    }
    current.count += 1;
    return current.count <= maximum;
  }

  private idleSessionMs(): number {
    return this.options.sessionIdleMs ?? SESSION_IDLE_MS;
  }

  private absoluteSessionMs(): number {
    return this.options.sessionAbsoluteMs ?? SESSION_ABSOLUTE_MS;
  }
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

function asRequestError(error: unknown): HttpError | null {
  if (error instanceof HttpError) return error;
  if (error instanceof ChannelSetupError) {
    return new HttpError(error.status, error.code, error.message);
  }
  if (error instanceof ControlPlaneConflictError) {
    return new HttpError(409, "version_conflict", error.message);
  }
  if (error instanceof ControlPlaneValidationError) {
    return new HttpError(400, "validation_rejected", error.message);
  }
  return null;
}

function applySecurityHeaders(response: ServerResponse): void {
  response.setHeader("cache-control", "no-store");
  response.setHeader("content-security-policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("x-frame-options", "DENY");
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader("permissions-policy", "camera=(), microphone=(), geolocation=()");
}

function sendText(
  response: ServerResponse,
  status: number,
  contentType: string,
  body: string,
): void {
  response.statusCode = status;
  response.setHeader("content-type", contentType);
  response.end(body);
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify(body));
}

function apiError(code: string, message: string): { error: { code: string; message: string } } {
  return { error: { code, message } };
}

async function readJsonObject(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > BODY_LIMIT_BYTES) {
      throw new HttpError(413, "body_too_large", "Body melebihi batas Console.");
    }
    chunks.push(buffer);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw new HttpError(400, "invalid_json", "JSON tidak sah.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new HttpError(400, "object_required", "Body harus berupa object JSON.");
  }
  return parsed as Record<string, unknown>;
}

function assertExactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  optional = false,
): void {
  const allowedSet = new Set(allowed);
  if (Object.keys(value).some((key) => !allowedSet.has(key))) {
    throw new HttpError(400, "unknown_field", "Body membawa field yang tidak dikenal.");
  }
  if (!optional && allowed.some((key) => !(key in value))) {
    throw new HttpError(400, "missing_field", "Body belum lengkap.");
  }
}

function assertRequiredKeys(
  value: Record<string, unknown>,
  required: readonly string[],
): void {
  if (required.some((key) => !(key in value))) {
    throw new HttpError(400, "missing_field", "Body belum lengkap.");
  }
}

function requireConfirmation(
  body: Record<string, unknown>,
  expected: string,
  additionalFields: readonly string[] = [],
): void {
  assertExactKeys(body, [...additionalFields, "confirmation"]);
  const confirmation = readString(body.confirmation, "confirmation", 96);
  if (!constantEqual(confirmation, expected)) {
    throw new HttpError(
      400,
      "confirmation_rejected",
      "Frasa konfirmasi tidak cocok.",
    );
  }
}

function readPlanComputePolicy(value: unknown): PlanComputePolicy | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "invalid_field", "Field computePolicy harus berupa object.");
  }
  const policy = value as Record<string, unknown>;
  assertExactKeys(policy, [
    "unitVersion",
    "includedComputeUnits",
    "billingPeriodDays",
    "rollingWindowHours",
    "rollingComputeLimit",
    "legacyTokenOverlay",
  ]);
  const overlayValue = policy.legacyTokenOverlay;
  if (!overlayValue || typeof overlayValue !== "object" || Array.isArray(overlayValue)) {
    throw new HttpError(400, "invalid_field", "Field legacyTokenOverlay harus berupa object.");
  }
  const overlay = overlayValue as Record<string, unknown>;
  assertExactKeys(overlay, ["schemaVersion", "computeUnitsPerToken"]);
  if (policy.unitVersion !== 1 || overlay.schemaVersion !== 1) {
    throw new HttpError(400, "invalid_field", "Versi unit compute tidak didukung.");
  }
  return {
    unitVersion: 1,
    includedComputeUnits: readComputeAmount(
      policy.includedComputeUnits,
      "includedComputeUnits",
    ),
    billingPeriodDays: readInteger(policy.billingPeriodDays),
    rollingWindowHours: readInteger(policy.rollingWindowHours),
    rollingComputeLimit: readComputeAmount(
      policy.rollingComputeLimit,
      "rollingComputeLimit",
    ),
    legacyTokenOverlay: {
      schemaVersion: 1,
      computeUnitsPerToken: readComputeAmount(
        overlay.computeUnitsPerToken,
        "computeUnitsPerToken",
      ),
    },
  };
}

function readComputeAmount(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^\d{1,80}$/u.test(value)) {
    throw new HttpError(400, "invalid_field", `Field ${field} harus integer fixed-point.`);
  }
  return BigInt(value).toString();
}

function readUsageTiers(
  value: unknown,
): ("cheap" | "efficient" | "ambitious")[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 3) {
    throw new HttpError(400, "invalid_field", "eligibleTiers tidak sah.");
  }
  const tiers = value.map((item) =>
    readEnum(item, ["cheap", "efficient", "ambitious"] as const)
  );
  if (new Set(tiers).size !== tiers.length) {
    throw new HttpError(400, "invalid_field", "eligibleTiers tidak boleh duplikat.");
  }
  return tiers;
}

function readString(value: unknown, field: string, maximum: number): string {
  if (typeof value !== "string") {
    throw new HttpError(400, "invalid_field", `Field ${field} harus berupa teks.`);
  }
  const clean = value.trim();
  if (!clean || clean.length > maximum || /[\u0000-\u001f]/u.test(clean)) {
    throw new HttpError(400, "invalid_field", `Field ${field} tidak sah.`);
  }
  return clean;
}

function readNullableString(value: unknown, maximum: number): string | null {
  if (value === undefined || value === null || value === "") return null;
  return readString(value, "rate", maximum);
}

function readInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new HttpError(400, "invalid_integer", "Angka harus integer non-negatif.");
  }
  return value as number;
}

function readNullableInteger(value: unknown): number | null {
  return value === null ? null : readInteger(value);
}

function readEnum<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
): T[number] {
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new HttpError(400, "invalid_enum", "Nilai pilihan tidak sah.");
  }
  return value as T[number];
}

function readExpectedVersion(request: IncomingMessage): number {
  const raw = request.headers["if-match"];
  const clean = typeof raw === "string" ? raw.replace(/^"|"$/gu, "") : "";
  const version = Number(clean);
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new HttpError(428, "version_required", "Header If-Match versi diperlukan.");
  }
  return version;
}

function enrollmentPatch(body: Record<string, unknown>): {
  operatorLabel?: string | null;
  cohort?: "standard" | "beta";
  planId?: string;
  quotaOverride?: number | null;
  betaExpiresAt?: string | null;
  groupRuntimeMode?: GroupRuntimeMode | null;
} {
  const patch: {
    operatorLabel?: string | null;
    cohort?: "standard" | "beta";
    planId?: string;
    quotaOverride?: number | null;
    betaExpiresAt?: string | null;
    groupRuntimeMode?: GroupRuntimeMode | null;
  } = {};
  if (body.operatorLabel !== undefined) patch.operatorLabel = readNullableString(body.operatorLabel, 64);
  if (body.cohort !== undefined) patch.cohort = readEnum(body.cohort, ["standard", "beta"] as const);
  if (body.planId !== undefined) patch.planId = readString(body.planId, "planId", 160);
  if (body.quotaOverride !== undefined) patch.quotaOverride = readNullableInteger(body.quotaOverride);
  if (body.betaExpiresAt !== undefined) patch.betaExpiresAt = body.betaExpiresAt === null ? null : readString(body.betaExpiresAt, "betaExpiresAt", 40);
  if (body.groupRuntimeMode !== undefined) patch.groupRuntimeMode = body.groupRuntimeMode === null ? null : readEnum(body.groupRuntimeMode, ["direct_only", "ambient", "paused", "disabled"] as const);
  return patch;
}

function usageFilter(search: URLSearchParams): UsageLedgerFilter {
  const filter: UsageLedgerFilter = {};
  const since = search.get("since");
  const until = search.get("until");
  const subjectRef = search.get("subjectRef");
  const actorRef = search.get("actorRef");
  const providerId = search.get("providerId");
  const modelId = search.get("modelId");
  const costCenter = search.get("costCenter");
  const environment = search.get("environment");
  const cohort = search.get("cohort");
  const planId = search.get("planId");
  const limit = search.get("limit");
  if (since) filter.since = readIsoQuery(since);
  if (until) filter.until = readIsoQuery(until);
  if (subjectRef) filter.subjectRef = decodeSafeRef(subjectRef);
  if (actorRef) filter.actorRef = decodeSafeRef(actorRef);
  if (providerId) filter.providerId = providerId.slice(0, 160);
  if (modelId) filter.modelId = modelId.slice(0, 160);
  if (costCenter) filter.costCenter = readEnum(costCenter, ["runtime", "evaluation", "probe", "migration"] as const) as UsageCostCenter;
  if (environment) filter.environment = readEnum(environment, ["development", "staging", "production"] as const) as RuntimeEnvironment;
  if (cohort) filter.cohort = readEnum(cohort, ["standard", "beta"] as const);
  if (planId) filter.planId = planId.slice(0, 160);
  if (limit) filter.limit = Math.max(1, Math.min(1_000, Number(limit) || 250));
  return filter;
}

function readIsoQuery(value: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new HttpError(400, "invalid_time", "Waktu query tidak sah.");
  }
  return new Date(parsed).toISOString();
}

function parseCookies(raw: string): Map<string, string> {
  const cookies = new Map<string, string>();
  for (const item of raw.split(";")) {
    const separator = item.indexOf("=");
    if (separator < 1) continue;
    cookies.set(item.slice(0, separator).trim(), item.slice(separator + 1).trim());
  }
  return cookies;
}

function constantEqual(left: string | string[], right: string): boolean {
  if (Array.isArray(left)) return false;
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function isLoopback(value: string | undefined): boolean {
  return value === "127.0.0.1" || value === "::1" || value === "::ffff:127.0.0.1";
}

function decodeSafeRef(value: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    throw new HttpError(400, "invalid_reference", "Reference tidak sah.");
  }
  if (!/^[a-zA-Z0-9_-]{4,96}$/u.test(decoded)) {
    throw new HttpError(400, "invalid_reference", "Reference tidak sah.");
  }
  return decoded;
}

function describeMutation(
  url: URL,
  method: string | undefined,
): MutationDescriptor {
  if (
    method === "POST" &&
    /\/channel-setup\/(telegram\/tester|whatsapp\/(harvy|tester))\/pair$/u.test(url.pathname)
  ) {
    return { action: "channel_pairing_start", targetRef: channelAuditTarget(url.pathname) };
  }
  if (
    method === "POST" &&
    /\/channel-setup\/(telegram\/tester|whatsapp\/(harvy|tester))\/cancel$/u.test(url.pathname)
  ) {
    return { action: "channel_pairing_cancel", targetRef: channelAuditTarget(url.pathname) };
  }
  if (
    method === "POST" &&
    (url.pathname.endsWith("/telegram/bot-token") ||
      url.pathname.endsWith("/telegram/tester/password"))
  ) {
    return { action: "channel_credential_update", targetRef: channelAuditTarget(url.pathname) };
  }
  if (
    method === "DELETE" &&
    (url.pathname.endsWith("/telegram/bot-token") ||
      url.pathname.endsWith("/telegram/tester") ||
      /\/channel-setup\/whatsapp\/(harvy|tester)\/session$/u.test(url.pathname))
  ) {
    return { action: "channel_credential_revoke", targetRef: channelAuditTarget(url.pathname) };
  }
  if (method === "POST" && url.pathname === "/api/v1/enrollments") {
    return { action: "enrollment_create", targetRef: null };
  }
  const enrollment = /^\/api\/v1\/enrollments\/([^/]+)$/u.exec(url.pathname);
  if (method === "PUT" && enrollment?.[1]) {
    return {
      action: "enrollment_update",
      targetRef: safeAuditTarget(enrollment[1]),
    };
  }
  const consent = /^\/api\/v1\/evaluation-consents\/([^/]+)\/(invite|revoke)$/u.exec(
    url.pathname,
  );
  if (method === "POST" && consent?.[1]) {
    return {
      action: consent[2] === "invite" ? "evaluation_invite" : "evaluation_revoke",
      targetRef: safeAuditTarget(consent[1]),
    };
  }
  if (method === "POST" && url.pathname === "/api/v1/plans/versions") {
    return { action: "plan_version_create", targetRef: null };
  }
  if (method === "POST" && url.pathname === "/api/v1/economy/credentials") {
    return { action: "economy_credential_create", targetRef: null };
  }
  const credential = /^\/api\/v1\/economy\/credentials\/([^/]+)$/u.exec(
    url.pathname,
  );
  if (method === "DELETE" && credential?.[1]) {
    return {
      action: "economy_credential_revoke",
      targetRef: safeAuditTarget(credential[1]),
    };
  }
  if (method === "POST" && url.pathname === "/api/v1/prices/versions") {
    return { action: "price_version_create", targetRef: null };
  }
  return { action: "unknown_mutation", targetRef: null };
}

function readOpaqueSecret(value: unknown, field: string, maximum: number): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximum ||
    /\p{Cc}/u.test(value)
  ) {
    throw new HttpError(400, "invalid_field", `Field ${field} tidak sah.`);
  }
  return value;
}

function channelAuditTarget(pathname: string): string | null {
  if (pathname.includes("/telegram/bot-token")) return "telegram_bot";
  if (pathname.includes("/telegram/tester")) return "telegram_tester";
  if (pathname.includes("/whatsapp/harvy")) return "whatsapp_harvy";
  if (pathname.includes("/whatsapp/tester")) return "whatsapp_tester";
  return null;
}

function safeAuditTarget(raw: string): string | null {
  try {
    const decoded = decodeURIComponent(raw);
    return /^[a-zA-Z0-9_-]{4,96}$/u.test(decoded) ? decoded : null;
  } catch {
    return null;
  }
}

function enrollmentTarget(value: unknown): string | null {
  const subjectRef = (value as Partial<Enrollment>)?.subjectRef;
  return typeof subjectRef === "string" ? subjectRef : null;
}

function errorCode(error: unknown): string {
  if (error instanceof HttpError) return error.code;
  if (error instanceof ChannelSetupError) return error.code;
  if (error instanceof ControlPlaneConflictError) return "version_conflict";
  if (error instanceof ControlPlaneValidationError) return "validation_rejected";
  return "internal_error";
}

function fundingCostBreakdown(
  attempts: readonly ConsoleProviderAttempt[],
): Record<string, string> {
  const totals = new Map<string, bigint>();
  for (const attempt of attempts) {
    if (attempt.cost.effectiveUsdNanos === null) continue;
    const source = attempt.fundingSource ?? "unattributed_legacy";
    totals.set(source, (totals.get(source) ?? 0n) + BigInt(attempt.cost.effectiveUsdNanos));
  }
  return Object.fromEntries(
    [...totals.entries()].sort(([left], [right]) => left.localeCompare(right, "en"))
      .map(([source, value]) => [source, value.toString()]),
  );
}
