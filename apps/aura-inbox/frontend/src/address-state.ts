type AddressState = { status: string; domain_status: string; provisioning_status: string };

export function isReceiving(a: AddressState): boolean {
  return a.status === 'active' && a.domain_status === 'active' && a.provisioning_status === 'active';
}

export function addressChip(a: AddressState): { label: string; tone: string; retry: boolean } {
  if (a.status !== 'active') return { label: a.status === 'released' ? 'Released' : 'Disabled', tone: 'archived', retry: false };
  if (a.domain_status !== 'active') return { label: 'Domain not active', tone: 'archived', retry: false };
  if (a.provisioning_status === 'failed') return { label: 'Failed', tone: 'failed', retry: true };
  if (a.provisioning_status === 'provisioning_pending') return { label: 'Provisioning pending', tone: 'closed', retry: true };
  return { label: 'Active', tone: 'open', retry: false };
}
