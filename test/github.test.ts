import { addGithubMarker, findGithubIssueTask, parseGithubIssueRef } from '../src/github.js';
import { AppError } from '../src/errors.js';
import { testTask } from './helpers.js';

describe('GitHub issue references', () => {
  it('parses short references and canonical issue URLs', () => {
    const short = parseGithubIssueRef('Amorem/demo#42');
    const url = parseGithubIssueRef('https://github.com/Amorem/demo/issues/42/');

    expect(short.key).toBe('amorem/demo#42');
    expect(short.canonicalUrl).toBe('https://github.com/Amorem/demo/issues/42');
    expect(url.marker).toBe(short.marker);
  });

  it('rejects pull request URLs and malformed references', () => {
    expect(() => parseGithubIssueRef('https://github.com/Amorem/demo/pull/42')).toThrow(AppError);
    expect(() => parseGithubIssueRef('Amorem/demo#0')).toThrow('GitHub issue must be');
    expect(() => parseGithubIssueRef('Amorem/demo/issues/42')).toThrow('GitHub issue must be');
  });

  it('finds the marker before less reliable matches', () => {
    const issue = parseGithubIssueRef('Amorem/demo#42');
    const marked = testTask({ id: 'marked', notes: addGithubMarker('Do it', issue) });
    const urlTask = testTask({
      id: 'url',
      notes: 'See https://github.com/Amorem/demo/issues/42 for context',
    });

    expect(findGithubIssueTask([urlTask, marked], issue)).toEqual({ task: marked, kind: 'marker' });
  });

  it('recognizes native GitHub tasks and refuses ambiguous duplicates', () => {
    const issue = parseGithubIssueRef('Amorem/demo#42');
    const native = testTask({ id: 'native', issueType: 'GITHUB', issueId: 42 });
    expect(findGithubIssueTask([native], issue)).toEqual({ task: native, kind: 'native-github' });

    expect(() =>
      findGithubIssueTask(
        [native, testTask({ id: 'native-2', issueType: 'GITHUB', issueId: 42 })],
        issue,
      ),
    ).toThrow('refusing to choose silently');
  });
});
