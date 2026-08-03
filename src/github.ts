import { AppError } from './errors.js';
import type { SpTask } from './types.js';

const REPO_PART = '[A-Za-z0-9_.-]+';
const ISSUE_NUMBER = '[1-9][0-9]*';
const SHORT_REF_PATTERN = new RegExp(`^(${REPO_PART})/(${REPO_PART})#(${ISSUE_NUMBER})$`);
const URL_REF_PATTERN = new RegExp(
  String.raw`^https://(?:www\.)?github\.com/(${REPO_PART})/(${REPO_PART})/issues/(${ISSUE_NUMBER})/?$`,
  'i',
);

export interface GithubIssueRef {
  readonly owner: string;
  readonly repo: string;
  readonly number: number;
  readonly key: string;
  readonly canonicalUrl: string;
  readonly marker: string;
}

export type GithubTaskMatchKind = 'marker' | 'url' | 'native-github';

export interface GithubTaskMatch {
  readonly task: SpTask;
  readonly kind: GithubTaskMatchKind;
}

export const parseGithubIssueRef = (value: string): GithubIssueRef => {
  const input = value.trim();
  const match = input.startsWith('http')
    ? URL_REF_PATTERN.exec(input)
    : SHORT_REF_PATTERN.exec(input);

  if (!match) {
    throw new AppError(
      'INVALID_GITHUB_ISSUE_REF',
      'GitHub issue must be an https://github.com/owner/repo/issues/123 URL or owner/repo#123',
    );
  }

  const [, owner, repo, numberText] = match;
  const number = Number(numberText);
  if (!owner || !repo || !Number.isSafeInteger(number) || number < 1) {
    throw new AppError(
      'INVALID_GITHUB_ISSUE_REF',
      'GitHub issue reference contains an invalid issue number',
    );
  }

  const key = `${owner.toLowerCase()}/${repo.toLowerCase()}#${number}`;
  const canonicalUrl = `https://github.com/${owner}/${repo}/issues/${number}`;
  return {
    owner,
    repo,
    number,
    key,
    canonicalUrl,
    marker: `<!-- super-productivity-mcp:github ${key} -->`,
  };
};

const normalizeUrl = (value: string): string => value.trim().replace(/\/$/, '').toLowerCase();

const isNativeGithubMatch = (task: SpTask, issue: GithubIssueRef): boolean =>
  task.issueType?.toUpperCase() === 'GITHUB' && String(task.issueId ?? '') === String(issue.number);

export const findGithubIssueTask = (
  tasks: SpTask[],
  issue: GithubIssueRef,
): GithubTaskMatch | undefined => {
  const exactMarker = tasks.filter((task) => task.notes?.includes(issue.marker));
  if (exactMarker.length > 1) {
    throw new AppError(
      'DUPLICATE_GITHUB_TASKS',
      `More than one task contains the Super Productivity MCP marker for ${issue.key}; refusing to choose silently`,
      { details: exactMarker.map((task) => task.id) },
    );
  }
  if (exactMarker[0]) return { task: exactMarker[0], kind: 'marker' };

  const exactUrl = normalizeUrl(issue.canonicalUrl);
  const urlMatches = tasks.filter(
    (task) => task.notes && normalizeUrl(task.notes).includes(exactUrl),
  );
  if (urlMatches.length > 1) {
    throw new AppError(
      'DUPLICATE_GITHUB_TASKS',
      `More than one task contains the GitHub URL for ${issue.key}; refusing to choose silently`,
      { details: urlMatches.map((task) => task.id) },
    );
  }
  if (urlMatches[0]) return { task: urlMatches[0], kind: 'url' };

  const nativeMatches = tasks.filter((task) => isNativeGithubMatch(task, issue));
  if (nativeMatches.length > 1) {
    throw new AppError(
      'AMBIGUOUS_GITHUB_TASK',
      `Multiple native GitHub tasks use issue number ${issue.number}; the local API does not expose the configured repository, so refusing to choose silently`,
      { details: nativeMatches.map((task) => task.id) },
    );
  }
  if (nativeMatches[0]) return { task: nativeMatches[0], kind: 'native-github' };

  return undefined;
};

export const addGithubMarker = (notes: string | undefined, issue: GithubIssueRef): string => {
  const base = notes?.trim();
  return base ? `${base}\n\n${issue.marker}` : issue.marker;
};
