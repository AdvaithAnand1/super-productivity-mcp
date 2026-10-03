import type { SpTask } from './types.js';

export type TaskQueueKind = 'overdue' | 'upcoming' | 'unscheduled';
export type TaskQueueReason = 'schedule' | 'deadline';

export interface TaskQueueMatch {
  readonly task: SpTask;
  readonly reasons: readonly TaskQueueReason[];
  readonly relevantDates: readonly string[];
}

const timestampToLocalDay = (timestamp: number): string => {
  const date = new Date(timestamp);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const addDays = (day: string, amount: number): string => {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
};

const taskDates = (task: SpTask): { schedule?: string; deadline?: string } => ({
  ...(typeof task.dueWithTime === 'number'
    ? { schedule: timestampToLocalDay(task.dueWithTime) }
    : task.dueDay
      ? { schedule: task.dueDay }
      : {}),
  ...(typeof task.deadlineWithTime === 'number'
    ? { deadline: timestampToLocalDay(task.deadlineWithTime) }
    : task.deadlineDay
      ? { deadline: task.deadlineDay }
      : {}),
});

export const queryTaskQueue = (
  tasks: readonly SpTask[],
  options: { readonly kind: TaskQueueKind; readonly asOfDate: string; readonly withinDays: number },
): TaskQueueMatch[] => {
  const endDay = addDays(options.asOfDate, options.withinDays);
  const matches: TaskQueueMatch[] = [];

  for (const task of tasks) {
    const dates = taskDates(task);
    const entries = Object.entries(dates) as [TaskQueueReason, string][];
    let reasons: TaskQueueReason[];
    let relevantDates: string[];

    if (options.kind === 'unscheduled') {
      if (entries.length > 0) continue;
      reasons = [];
      relevantDates = [];
    } else if (options.kind === 'overdue') {
      const overdueEntries = entries.filter(([, day]) => day < options.asOfDate);
      if (overdueEntries.length === 0) continue;
      reasons = overdueEntries.map(([reason]) => reason);
      relevantDates = overdueEntries.map(([, day]) => day);
    } else {
      const upcomingEntries = entries.filter(([, day]) => day >= options.asOfDate && day <= endDay);
      if (upcomingEntries.length === 0) continue;
      reasons = upcomingEntries.map(([reason]) => reason);
      relevantDates = upcomingEntries.map(([, day]) => day);
    }

    matches.push({ task, reasons, relevantDates });
  }

  matches.sort((a, b) => {
    const aDate = a.relevantDates[0] ?? '';
    const bDate = b.relevantDates[0] ?? '';
    return aDate.localeCompare(bDate) || a.task.title.localeCompare(b.task.title);
  });
  return matches;
};
