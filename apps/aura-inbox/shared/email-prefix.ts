// Shared address namespace policy for Studio provisioning and the inbox client.
export const MAX_EMAIL_PREFIX_LENGTH = 64;
export const MAX_ROUTED_ADDRESS_LENGTH = 90;
const reservationKey=(prefix:string)=>prefix.toLowerCase().replace(/[.-]/g,'');
const RESERVED_PREFIXES = new Set([
  'anthony', 'melina', 'merlin', 'atlas', 'support', 'support-test',
  'sales', 'sales-test', 'operations', 'operations-test', 'notifications',
  'notifications-test', 'spike-test', 'no-reply', 'noreply',
  'postmaster', 'abuse', 'admin', 'hostmaster', 'webmaster',
  'orbi', 'daniel', 'olivia', 'sophia', 'lyra', 'nova', 'iris',
  'spike-test-2', 'mailer-daemon',
].map(reservationKey));
export class EmailPrefixError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status=status; }
}
export function isReservedPrefix(prefix: string): boolean {
  return RESERVED_PREFIXES.has(reservationKey(prefix));
}
export function existingPrefixNeedsManualRouting(prefix: string, domain: string): boolean {
  return isReservedPrefix(prefix) || prefix.length>MAX_EMAIL_PREFIX_LENGTH
    || !/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(prefix)
    || prefix.length+domain.length+1>MAX_ROUTED_ADDRESS_LENGTH;
}
export function validateEmailPrefix(value: unknown, domain: string): string {
  if(typeof value!=='string')throw new EmailPrefixError(400,'Enter an email prefix.');
  const prefix=value.trim().toLowerCase();
  if(!prefix || prefix.length>MAX_EMAIL_PREFIX_LENGTH || !/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(prefix)) {
    throw new EmailPrefixError(400,'Use letters and numbers with single dots or hyphens between them, up to 64 characters.');
  }
  if(isReservedPrefix(prefix))throw new EmailPrefixError(409,'This email prefix is reserved. Choose another prefix.');
  if(prefix.length+domain.length+1>MAX_ROUTED_ADDRESS_LENGTH)throw new EmailPrefixError(400,'This email address is too long for routing. Choose a shorter prefix.');
  return prefix;
}
export function emailSlug(name: string): string {
  return name.normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase()
    .replace(/[^a-z0-9.-]+/g,'-').replace(/([.-])[.-]+/g,'$1').replace(/^[.-]+|[.-]+$/g,'') || 'aura';
}
