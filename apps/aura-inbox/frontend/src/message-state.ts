export type MessageState = 'failed' | 'timed_out' | 'generating' | 'normal';

type StatefulMessage = { direction: string; status: string; body_storage: string; body_text: string | null;
  body_html: string | null; display_state?: string | null };

export function messageState(m: StatefulMessage): MessageState {
  if (m.direction !== 'out') return 'normal';
  if (m.status === 'failed') return 'failed';
  if (m.display_state === 'timed_out') return 'timed_out';
  // A sending row with a body is a send with an unknown outcome, not a reply still being written.
  if (m.status === 'sending' && m.body_storage === 'inline' && m.body_text === null && m.body_html === null) return 'generating';
  return 'normal';
}
