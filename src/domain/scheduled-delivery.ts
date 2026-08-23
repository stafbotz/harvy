/**
 * Durable fence around a scheduled outbound effect.
 *
 * `in_flight` is deliberately not retried after restart: once transport I/O
 * may have started, its outcome cannot be proven from Telegram/WhatsApp. This
 * chooses an honest at-most-once boundary over a duplicate reminder.
 */
export interface ScheduledDeliveryAttempt {
  effectId: string;
  status: "in_flight" | "sent" | "unknown";
  preparedAt: string;
  completedAt: string | null;
}
