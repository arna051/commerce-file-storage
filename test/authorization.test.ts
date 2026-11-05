import { describe, expect, it } from 'vitest';
import { MongooseAclAuthorizer, type FileGrant, type FileRecord } from '../src/index.js';

const base: FileRecord = {
  id: 'file-1',
  namespace: 'shop',
  storageTarget: 'default',
  objectKey: 'objects/file-1',
  contentType: 'image/jpeg',
  size: 1,
  sha256: 'a'.repeat(64),
  lifecycleStatus: 'available',
  scanStatus: 'not-required',
  processingStatus: 'not-required',
  access: { mode: 'restricted', policyVersion: 1 },
  references: [],
  variants: [],
  metadata: {},
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe('MongooseAclAuthorizer', () => {
  const authorize = (resource: FileRecord, grants: FileGrant[] = []) =>
    new MongooseAclAuthorizer({ listGrants: () => Promise.resolve(grants) });

  it('implements public, authenticated, owner, direct, group, role, and expired grants', async () => {
    const publicFile = { ...base, access: { mode: 'public' as const, policyVersion: 1 } };
    await expect(
      authorize(publicFile).authorize({
        principal: null,
        action: 'download',
        resource: publicFile,
      }),
    ).resolves.toMatchObject({ allowed: true, reasonCode: 'PUBLIC' });

    const authenticated = {
      ...base,
      access: { mode: 'authenticated' as const, policyVersion: 1 },
    };
    await expect(
      authorize(authenticated).authorize({
        principal: { type: 'user', id: 'u1' },
        action: 'read',
        resource: authenticated,
      }),
    ).resolves.toMatchObject({ allowed: true, reasonCode: 'AUTHENTICATED' });

    const owned = {
      ...base,
      access: {
        mode: 'restricted' as const,
        owner: { type: 'user' as const, id: 'owner' },
        policyVersion: 1,
      },
    };
    await expect(
      authorize(owned).authorize({
        principal: { type: 'user', id: 'owner' },
        action: 'manage-access',
        resource: owned,
      }),
    ).resolves.toMatchObject({ allowed: true, reasonCode: 'OWNER' });

    const grants: FileGrant[] = [
      {
        id: '1',
        fileId: base.id,
        principal: { type: 'user', id: 'direct' },
        actions: ['read'],
        createdAt: new Date(),
      },
      {
        id: '2',
        fileId: base.id,
        principal: { type: 'group', id: 'buyers' },
        actions: ['read'],
        createdAt: new Date(),
      },
      {
        id: '3',
        fileId: base.id,
        principal: { type: 'role', id: 'admin' },
        actions: ['delete'],
        createdAt: new Date(),
      },
      {
        id: '4',
        fileId: base.id,
        principal: { type: 'user', id: 'expired' },
        actions: ['read'],
        expiresAt: new Date(0),
        createdAt: new Date(),
      },
    ];
    const acl = authorize(base, grants);
    await expect(
      acl.authorize({ principal: { type: 'user', id: 'direct' }, action: 'read', resource: base }),
    ).resolves.toMatchObject({ allowed: true });
    await expect(
      acl.authorize({
        principal: { type: 'user', id: 'member', groups: ['buyers'] },
        action: 'read',
        resource: base,
      }),
    ).resolves.toMatchObject({ allowed: true });
    await expect(
      acl.authorize({
        principal: { type: 'user', id: 'staff', roles: ['admin'] },
        action: 'delete',
        resource: base,
      }),
    ).resolves.toMatchObject({ allowed: true });
    await expect(
      acl.authorize({ principal: { type: 'user', id: 'expired' }, action: 'read', resource: base }),
    ).resolves.toMatchObject({ allowed: false, reasonCode: 'NO_MATCHING_GRANT' });
    await expect(
      acl.authorize({ principal: null, action: 'read', resource: base }),
    ).resolves.toMatchObject({ allowed: false, reasonCode: 'AUTHENTICATION_REQUIRED' });
  });
});
