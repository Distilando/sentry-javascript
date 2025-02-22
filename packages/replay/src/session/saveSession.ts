import { REPLAY_SESSION_KEY, WINDOW } from '../constants';
import { Session } from './Session';

export function saveSession(session: Session): void {
  const hasSessionStorage = 'sessionStorage' in WINDOW;
  if (!hasSessionStorage) {
    return;
  }

  try {
    WINDOW.sessionStorage.setItem(REPLAY_SESSION_KEY, JSON.stringify(session));
  } catch {
    // Ignore potential SecurityError exceptions
  }
}
