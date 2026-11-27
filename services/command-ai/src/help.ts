export type CardMode = 'write' | 'checked' | 'fixed';

export interface HelpCard {
  id: string;
  pick: string;
  topic: string;
  kind: 'explain' | 'problem';
  mode: CardMode;
  urgent: boolean;
  lead: string[];
  facts: string[];
  limit: string[];
  required: string[];
  forbid: string[];
  answer: string;
}

export interface HelpDataset {
  forbid: string[];
  buttons: Record<string, { card: string; titles: string[] }>;
  facts: Record<string, { text: string; src: string[] }>;
  cards: HelpCard[];
}

export const HELP_RULES = '';

export function buildHelpPrompt(_system: string, _data: HelpDataset): string {
  return '';
}

export function matchTopicButton(_text: string, _topic: string | null, _data: HelpDataset): HelpCard | undefined {
  return undefined;
}

export function isPlaceholderOnly(_text: string): boolean {
  return false;
}

export function selectCard(_ids: unknown, _data: HelpDataset): HelpCard {
  return { id: '' } as HelpCard;
}

export function explainReply(_card: HelpCard): { op: 'explain'; topic: string; answer: string } {
  return { op: 'explain', topic: '', answer: '' };
}
