/** An error message without addresses or Firestore document paths (which name households). */
export function redact(message: string): string {
  return message
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]')
    .replace(/projects\/[^\s"']*\/documents\/[^\s"']*/g, '[document]')
    .replace(/households\/[^/\s"']+/g, 'households/[id]')
    .slice(0, 300);
}
