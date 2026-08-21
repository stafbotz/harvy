export interface TelegramCommandDefinition {
  command: string;
  description: string;
}

export interface TelegramCommandOptions {
  codingRuntime: boolean;
  githubPublishing: boolean;
}

/** Satu sumber untuk menu command Telegram dan tes kontraknya. */
export function telegramCommands(
  options: TelegramCommandOptions,
): TelegramCommandDefinition[] {
  return [
    { command: "tugas", description: "Lihat yang harus dikerjakan" },
    { command: "memori", description: "Lihat yang aku ingat tentang kamu" },
    { command: "bantuan", description: "Lihat cara pakai" },
    ...(options.codingRuntime
      ? [
          { command: "project", description: "Kelola workspace/project coding" },
          { command: "code", description: "Mulai CodingRun pada project aktif" },
          { command: "code_status", description: "Lihat status CodingRun" },
          { command: "code_cancel", description: "Batalkan CodingRun aktif" },
        ]
      : []),
    ...(options.githubPublishing
      ? [
          { command: "github", description: "Hubungkan GitHub App dan pilih repo" },
          { command: "publish", description: "Siapkan publish exact ke draft PR" },
        ]
      : []),
  ];
}
