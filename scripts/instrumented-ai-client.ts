import { AiClient } from "../src/ai/client.js";
import { aiClientOptions, type AppConfig } from "../src/config.js";
import { ControlPlaneService } from "../src/core/control-plane-service.js";
import { UsageLedgerService } from "../src/core/usage-ledger-service.js";
import type { UsageCostCenter } from "../src/domain/usage-ledger.js";
import { FileControlPlaneRepository } from "../src/storage/file-control-plane-repository.js";
import { FileUsageLedgerRepository } from "../src/storage/file-usage-ledger-repository.js";
import { FileEntitlementLedgerRepository } from "../src/storage/file-entitlement-ledger-repository.js";
import {
  acquireLocalRuntimeLock,
  localRuntimeLockPath,
} from "../src/core/local-runtime-lock.js";

/**
 * Probe/evaluator memakai ledger yang sama, tetapi menolak berjalan bersamaan
 * dengan runtime karena repository JSON hanya aman untuk satu proses.
 */
export async function createInstrumentedAiClient(
  config: AppConfig,
  costCenter: UsageCostCenter,
  allowFallback: boolean,
): Promise<AiClient> {
  await acquireLocalRuntimeLock(
    localRuntimeLockPath(config.controlPlane.file),
    costCenter === "evaluation" ? "evaluation" : "probe",
  );
  const controlPlane = new ControlPlaneService(
    new FileControlPlaneRepository(config.controlPlane.file),
    {
      fallbackRollingTokenLimit: config.ai.rollingTokenLimit,
      betaQuotaMultiplier: config.controlPlane.betaQuotaMultiplier,
      configuredModels: config.ai.configuredModels,
      priceBootstraps: (["cheap", "efficient", "ambitious"] as const).map(
        (tier) => ({
          providerId: config.ai.providerId,
          modelId:
            config.ai.mode === "testing"
              ? config.ai.testingModels[tier] ?? config.ai.testingModel
              : config.ai.models[tier],
          inputPerMillionUsd: String(
            config.ai.prices[tier].inputPerMillionUsd,
          ),
          outputPerMillionUsd: String(
            config.ai.prices[tier].outputPerMillionUsd,
          ),
        }),
      ),
    },
  );
  const ledger = new UsageLedgerService(
    new FileUsageLedgerRepository(config.controlPlane.usageLedgerFile),
    controlPlane,
    {
      retentionDays: config.controlPlane.usageLedgerRetentionDays,
      entitlementRepository: new FileEntitlementLedgerRepository(
        config.controlPlane.entitlementLedgerFile,
      ),
    },
  );
  return new AiClient({
    ...aiClientOptions(config.ai, { fallback: allowFallback }),
    attemptObserver: ledger,
    environment:
      config.operationalLog.environment === "production" ||
      config.operationalLog.environment === "staging"
        ? config.operationalLog.environment
        : "development",
    costCenter,
  });
}
