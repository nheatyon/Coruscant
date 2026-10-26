import type { Organization, Persona, Role } from '../shared/contracts.js';

/** Fixed local samples, never real accounts or production authentication. */
export interface DemoActor {
  id: string;
  name: string;
  audience: 'CUSTOMER' | 'STAFF';
  active: boolean;
  demonstration: true;
}

export interface DemoMembership {
  actorId: string;
  organizationId: string;
  organizationName: string;
  role: Role;
  canSelectOffers: boolean;
  active: true;
}

export const organizations: Organization[] = [
  { id: 'org-a', name: 'Demo Estuary Research' },
  { id: 'org-b', name: 'Demo Coastal Lab' },
];

export const actors: DemoActor[] = [
  { id: 'a-owner', name: 'A Owner', audience: 'CUSTOMER', active: true, demonstration: true },
  { id: 'a-requester', name: 'A Requester', audience: 'CUSTOMER', active: true, demonstration: true },
  { id: 'a-viewer', name: 'A Viewer', audience: 'CUSTOMER', active: true, demonstration: true },
  { id: 'b-owner', name: 'B Owner', audience: 'CUSTOMER', active: true, demonstration: true },
  { id: 'multi-viewer', name: 'Multi-workspace viewer', audience: 'CUSTOMER', active: true, demonstration: true },
  { id: 'no-workspace', name: 'No-workspace sample', audience: 'CUSTOMER', active: true, demonstration: true },
  { id: 'staff-admin', name: 'Staff Admin', audience: 'STAFF', active: true, demonstration: true },
];

export const memberships: DemoMembership[] = [
  { actorId: 'a-owner', organizationId: 'org-a', organizationName: organizations[0]!.name, role: 'OWNER', canSelectOffers: true, active: true },
  { actorId: 'a-requester', organizationId: 'org-a', organizationName: organizations[0]!.name, role: 'REQUESTER', canSelectOffers: false, active: true },
  { actorId: 'a-viewer', organizationId: 'org-a', organizationName: organizations[0]!.name, role: 'VIEWER', canSelectOffers: false, active: true },
  { actorId: 'b-owner', organizationId: 'org-b', organizationName: organizations[1]!.name, role: 'OWNER', canSelectOffers: true, active: true },
  { actorId: 'multi-viewer', organizationId: 'org-a', organizationName: organizations[0]!.name, role: 'VIEWER', canSelectOffers: false, active: true },
  { actorId: 'multi-viewer', organizationId: 'org-b', organizationName: organizations[1]!.name, role: 'VIEWER', canSelectOffers: false, active: true },
];

export const customerPersonas: Persona[] = [
  { id: 'a-owner', name: 'A Owner', description: 'Demonstration: Demo Estuary Research Owner with explicit offer-selection authority.' },
  { id: 'a-requester', name: 'A Requester', description: 'Demonstration: may submit and reply in organization A; cannot decide offers.' },
  { id: 'a-viewer', name: 'A Viewer', description: 'Demonstration: read-only access to permitted organization A records.' },
  { id: 'b-owner', name: 'B Owner', description: 'Demonstration: organization B Owner; no access to organization A records.' },
  { id: 'multi-viewer', name: 'Multi-workspace viewer', description: 'Demonstration: read-only member of A and B, for explicit workspace choice.' },
  { id: 'no-workspace', name: 'No-workspace sample', description: 'Demonstration: no configured workspace membership or protected record authority.' },
];
