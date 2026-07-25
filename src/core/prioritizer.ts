import type { StudentTask } from "../domain/task.js";

export function taskPriorityScore(task: StudentTask, now: Date): number {
  const importanceScore = task.importance * 10;

  if (!task.dueAt) {
    return importanceScore;
  }

  const hoursRemaining =
    (new Date(task.dueAt).getTime() - now.getTime()) / (60 * 60 * 1000);

  if (hoursRemaining < 0) return 100 + importanceScore;
  if (hoursRemaining <= 24) return 80 + importanceScore;
  if (hoursRemaining <= 72) return 50 + importanceScore;
  if (hoursRemaining <= 168) return 30 + importanceScore;
  return 10 + importanceScore;
}

export function sortTasksByPriority(
  tasks: StudentTask[],
  now: Date,
): StudentTask[] {
  return [...tasks].sort((left, right) => {
    const scoreDifference =
      taskPriorityScore(right, now) - taskPriorityScore(left, now);

    if (scoreDifference !== 0) return scoreDifference;

    if (left.dueAt && right.dueAt) {
      return left.dueAt.localeCompare(right.dueAt);
    }

    if (left.dueAt) return -1;
    if (right.dueAt) return 1;
    return left.createdAt.localeCompare(right.createdAt);
  });
}
