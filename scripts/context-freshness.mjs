#!/usr/bin/env node

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsyncDefault = promisify(execFile);

const INDONESIAN_MONTHS = {
  januari: "01",
  februari: "02",
  maret: "03",
  april: "04",
  mei: "05",
  juni: "06",
  juli: "07",
  agustus: "08",
  september: "09",
  oktober: "10",
  november: "11",
  desember: "12",
};

export function parseIndonesianOrIsoDate(raw) {
  if (!raw || typeof raw !== "string") {
    return null;
  }
  const trimmed = raw.trim();
  const isoMatch = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(trimmed);
  if (isoMatch) {
    const month = Number(isoMatch[2]);
    const day = Number(isoMatch[3]);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return trimmed;
    }
    return null;
  }
  const indoMatch = /^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/u.exec(trimmed);
  if (indoMatch) {
    const day = indoMatch[1].padStart(2, "0");
    const monthKey = indoMatch[2].toLowerCase();
    const month = INDONESIAN_MONTHS[monthKey];
    const year = indoMatch[3];
    if (month && Number(day) >= 1 && Number(day) <= 31) {
      return `${year}-${month}-${day}`;
    }
  }
  return null;
}

export function parseCurrentMetadata(currentText) {
  if (typeof currentText !== "string") {
    throw new Error("CURRENT.md content must be a string");
  }

  const refreshedMatch = /^Refreshed:\s*([^\r\n]+)$/mu.exec(currentText);
  if (!refreshedMatch) {
    throw new Error("CURRENT.md metadata malformed: missing Refreshed field");
  }
  const refreshedDate = parseIndonesianOrIsoDate(refreshedMatch[1]);
  if (!refreshedDate) {
    throw new Error(`CURRENT.md metadata malformed: invalid Refreshed date '${refreshedMatch[1].trim()}'`);
  }

  const baselineMatch = /^Baseline:\s*([0-9a-fA-F]{7,40})/mu.exec(currentText) ||
    /commit dasar\s*`([0-9a-fA-F]{7,40})`/mu.exec(currentText);
  const baseline = baselineMatch ? baselineMatch[1].toLowerCase() : null;
  if (!baseline) {
    throw new Error("CURRENT.md metadata malformed: missing Baseline commit reference");
  }

  const versionMatch = /^Context-Version:\s*(\d+)/mu.exec(currentText);
  const contextVersion = versionMatch ? Number(versionMatch[1]) : 1;

  const gates = {
    checkPass: /npm run check[`\s]+PASS/iu.test(currentText),
    testPass: /npm test[`\s]+PASS/iu.test(currentText),
    contextCheckPass: /npm run context:check[`\s]+PASS/iu.test(currentText),
  };

  return {
    refreshedDate,
    baseline,
    contextVersion,
    gates,
  };
}

export function parseStatusMetadata(statusText) {
  if (typeof statusText !== "string") {
    throw new Error("STATUS.md content must be a string");
  }

  const dateInHeaderMatch = /\((\d{1,2}\s+[A-Za-z]+\s+\d{4}|\d{4}-\d{2}-\d{2})\)/u.exec(statusText);
  const baselineDate = dateInHeaderMatch
    ? parseIndonesianOrIsoDate(dateInHeaderMatch[1])
    : null;

  const baselineCommitMatch = /commit dasar\s*`([0-9a-fA-F]{7,40})`/mu.exec(statusText) ||
    /^Baseline:\s*([0-9a-fA-F]{7,40})/mu.exec(statusText);
  const baselineCommit = baselineCommitMatch ? baselineCommitMatch[1].toLowerCase() : null;

  const tableDates = [];
  const tableRowRegex = /\|\s*[^|]+\s*\|\s*[^|]+\s*\|\s*[^|]+\s*\|\s*(\d{4}-\d{2}-\d{2})\s*\|/gu;
  let match;
  while ((match = tableRowRegex.exec(statusText)) !== null) {
    tableDates.push(match[1]);
  }
  tableDates.sort();
  const latestSubsystemDate = tableDates.length > 0 ? tableDates[tableDates.length - 1] : null;

  return {
    baselineDate: baselineDate || latestSubsystemDate,
    baselineCommit,
    latestSubsystemDate,
  };
}

export function parseLogMetadata(logText) {
  if (typeof logText !== "string") {
    throw new Error("LOG.md content must be a string");
  }

  const entries = [];
  const entryRegex = /^## (\d{4}-\d{2}-\d{2}) — (.+)$/gmu;
  let match;
  while ((match = entryRegex.exec(logText)) !== null) {
    entries.push({
      date: match[1],
      title: match[2].trim(),
    });
  }

  return {
    entries,
    latestEntry: entries.length > 0 ? entries[0] : null,
  };
}

export async function validateContextFreshness({
  root,
  readRepositoryFile,
  execFileAsync = execFileAsyncDefault,
  currentContent,
  statusContent,
  logContent,
}) {
  const warnings = [];

  const [currentText, statusText, logText] = await Promise.all([
    currentContent !== undefined ? currentContent : readRepositoryFile("docs/agent/CURRENT.md"),
    statusContent !== undefined ? statusContent : readRepositoryFile("docs/engineering/STATUS.md"),
    logContent !== undefined ? logContent : readRepositoryFile("docs/LOG.md"),
  ]);

  const currentMeta = parseCurrentMetadata(currentText);
  const statusMeta = parseStatusMetadata(statusText);
  const logMeta = parseLogMetadata(logText);

  // 1. Verify baseline commit object in git if available
  if (root && currentMeta.baseline) {
    try {
      const { stdout } = await execFileAsync("git", ["cat-file", "-t", currentMeta.baseline], {
        cwd: root,
        encoding: "utf8",
      });
      if (stdout.trim() !== "commit") {
        throw new Error(
          `CURRENT.md baseline '${currentMeta.baseline}' is not a valid commit object`,
        );
      }
    } catch (error) {
      if (error?.message?.includes("is not a valid commit object")) {
        throw error;
      }
      if (error?.stderr?.includes("fatal:") || error?.code !== 0) {
        throw new Error(
          `CURRENT.md baseline commit '${currentMeta.baseline}' does not exist in repository`,
        );
      }
    }
  }

  // 2. Deterministic check: STATUS.md baseline date vs CURRENT.md refreshed date
  if (statusMeta.baselineDate && currentMeta.refreshedDate < statusMeta.baselineDate) {
    throw new Error(
      `CURRENT.md is stale: Refreshed date (${currentMeta.refreshedDate}) is older than STATUS baseline date (${statusMeta.baselineDate})`,
    );
  }

  // 3. Deterministic check: STATUS.md baseline commit vs CURRENT.md baseline commit
  if (
    root &&
    statusMeta.baselineCommit &&
    currentMeta.baseline &&
    statusMeta.baselineCommit !== currentMeta.baseline
  ) {
    try {
      await execFileAsync(
        "git",
        ["merge-base", "--is-ancestor", currentMeta.baseline, statusMeta.baselineCommit],
        { cwd: root },
      );
      if (statusMeta.baselineDate && statusMeta.baselineDate > currentMeta.refreshedDate) {
        throw new Error(
          `CURRENT.md baseline '${currentMeta.baseline}' is older than STATUS baseline '${statusMeta.baselineCommit}'`,
        );
      }
    } catch {
      // not an ancestor or git error
    }
  }

  // 4. Soft checks -> Warnings
  if (logMeta.latestEntry && logMeta.latestEntry.date > currentMeta.refreshedDate) {
    warnings.push(
      `CURRENT.md (${currentMeta.refreshedDate}) may precede latest LOG entry (${logMeta.latestEntry.date} — ${logMeta.latestEntry.title})`,
    );
  }

  return {
    ok: true,
    warnings,
    metadata: {
      current: currentMeta,
      status: statusMeta,
      log: logMeta,
    },
  };
}
