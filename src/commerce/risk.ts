// Soft signal only (a review, never a rejection): a short list of well-known throwaway inbox providers.
const DISPOSABLE = new Set(['mailinator.com', 'guerrillamail.com', 'guerrillamail.net', 'sharklasers.com', 'grr.la', '10minutemail.com', '10minutemail.net', 'temp-mail.org', 'tempmail.com', 'tempmail.net',
  'tempmailo.com', 'temp-mail.io', 'throwawaymail.com', 'yopmail.com', 'yopmail.net', 'getnada.com', 'nada.email', 'dispostable.com', 'trashmail.com', 'trashmail.de', 'maildrop.cc', 'mailnesia.com',
  'mintemail.com', 'mohmal.com', 'fakeinbox.com', 'emailondeck.com', 'spamgourmet.com', 'mailcatch.com', 'moakt.com', 'tmpmail.org', 'burnermail.io', 'discard.email', '33mail.com', 'mail.tm']);

/** Matches the domain and its subdomains (e.g. x.mailinator.com). Expects a normalized email. */
export function disposableEmail(email: string) {
  const labels = email.slice(email.lastIndexOf('@') + 1).split('.');
  return labels.some((_, i) => DISPOSABLE.has(labels.slice(i).join('.')));
}
