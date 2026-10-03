import { queryTaskQueue } from '../src/task-queue.js';
import { testTask } from './helpers.js';

describe('queryTaskQueue', () => {
  const options = { asOfDate: '2026-10-02', withinDays: 7 };
  const tasks = [
    testTask({ id: 'old-plan', title: 'Old plan', dueDay: '2026-10-01' }),
    testTask({ id: 'old-deadline', title: 'Old deadline', deadlineDay: '2026-10-01' }),
    testTask({
      id: 'near',
      title: 'Near',
      dueDay: '2026-10-03',
      deadlineDay: '2026-10-05',
    }),
    testTask({ id: 'distant', title: 'Distant', deadlineDay: '2026-10-15' }),
    testTask({ id: 'open', title: 'Open' }),
  ];

  it('finds overdue plans or deadlines and returns why each task matched', () => {
    const result = queryTaskQueue(tasks, { ...options, kind: 'overdue' });
    expect(result.map(({ task, reasons }) => [task.id, reasons])).toEqual([
      ['old-deadline', ['deadline']],
      ['old-plan', ['schedule']],
    ]);
  });

  it('finds upcoming schedule/deadline dates within an inclusive day range', () => {
    const result = queryTaskQueue(tasks, { ...options, kind: 'upcoming' });
    expect(result.map(({ task, reasons }) => [task.id, reasons])).toEqual([
      ['near', ['schedule', 'deadline']],
    ]);
  });

  it('finds tasks with neither a plan nor deadline', () => {
    const result = queryTaskQueue(tasks, { ...options, kind: 'unscheduled' });
    expect(result.map(({ task }) => task.id)).toEqual(['open']);
  });
});
