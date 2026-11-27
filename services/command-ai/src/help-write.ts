import type { HelpCard, HelpDataset } from './help';

export const WRITER_RULES = '';
export const CHECKER_RULES = '';
export const WRITER_SCHEMA: object = {};
export const CHECKER_SCHEMA: object = {};

export function writeCards(_selected: HelpCard[], _data: HelpDataset): HelpCard[] {
  return [];
}

export const neutralQuestion = (text: string): string => text;

export interface WriterInput {
  system: string;
  user: string;
  budget: number;
  /** Best first. The prompt lists them in id order, so the writer never sees the router's ranking. */
  cards: HelpCard[];
}

export function writerInput(
  _cards: HelpCard[],
  _data: HelpDataset,
  _question: string,
  _previousTopic: string | null
): WriterInput {
  return { system: '', user: '{}', budget: 0, cards: [] };
}
