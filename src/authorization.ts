import type {
  AuthorizationRequest,
  FileAction,
  FileAuthorizer,
  MetadataStore,
} from './contracts.js';

const publicActions: readonly FileAction[] = ['read', 'download'];

export class MongooseAclAuthorizer implements FileAuthorizer {
  constructor(private readonly metadata: Pick<MetadataStore, 'listGrants'>) {}

  async authorize(request: AuthorizationRequest) {
    const { principal, action, resource } = request;
    if (resource.access.mode === 'public' && publicActions.includes(action))
      return { allowed: true, reasonCode: 'PUBLIC' };
    if (!principal) return { allowed: false, reasonCode: 'AUTHENTICATION_REQUIRED' };
    if (resource.access.mode === 'authenticated' && publicActions.includes(action))
      return { allowed: true, reasonCode: 'AUTHENTICATED' };
    const owner = resource.access.owner;
    if (owner?.type === principal.type && owner.id === principal.id)
      return { allowed: true, reasonCode: 'OWNER' };
    const groups = new Set(principal.groups ?? []);
    const roles = new Set(principal.roles ?? []);
    const now = Date.now();
    const grants = await this.metadata.listGrants(resource.id);
    const match = grants.some((grant) => {
      if (grant.expiresAt && grant.expiresAt.getTime() <= now) return false;
      if (!grant.actions.includes(action)) return false;
      if (grant.principal.type === principal.type && grant.principal.id === principal.id)
        return true;
      if (grant.principal.type === 'group') return groups.has(grant.principal.id);
      if (grant.principal.type === 'role') return roles.has(grant.principal.id);
      return false;
    });
    return { allowed: match, reasonCode: match ? 'GRANT' : 'NO_MATCHING_GRANT' };
  }
}
